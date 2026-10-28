import type { BridgeDatabase } from "@bridge/server/database";
import {
  allowlistUser,
  APPLY_VERIFY_MS,
  type Approval,
  type StaleReason,
} from "@links/model/approvals";
import {
  factsNeeded,
  judgeApply,
  type AllowlistEntry,
  type ApplyVerdict,
  type FactsNeeded,
  type FreshFacts,
} from "@links/model/setup";
import { tsAt } from "@slackapi/model/ts";
import { readPersonIds } from "@slackapi/server/users";
import {
  expireApprovals,
  readAllOpenApprovals,
  readApproval,
  recordApplied,
  staleApprovals,
} from "./approvals";
import type { FactsReader, Unverified } from "./facts";
import { linkedElsewhere, readSetupState } from "./setup";

// Applying approved changes.
//
// The owner's click is decided before Slack is acked, and an approved change applies after,
// against facts read fresh for it, outside any transaction. Only the last step is a transaction:
// it reads the approval and what it's judged against again, and puts exactly its patch in, with
// an audit entry, while the card's read-set still holds and the change is still valid, or marks it
// stale with the reason. A read that proves nothing is tried again with backoff, and an approval
// still unverified 15 minutes after the click goes stale, as does one Slack stays disconnected
// for. The applier starts with every approval left approved, so a decision committed before a
// crash still applies or goes stale, and it expires every card whose hour is up.

export interface Applier {
  /** Applies again, because the owner decided a card or something an approval waits on changed. */
  reconsider(): void;
  /** Stops once the pass in flight has recorded what it did, abandoning any read. */
  stop(): Promise<void>;
}

/** How long the applier waits to read facts again after a read that proved nothing. */
export type ApplierTimings = {
  /** The first wait, which doubles with each read in a row that proves nothing. */
  retry: number;
  retryLimit: number;
};

export const defaultApplierTimings: ApplierTimings = { retry: 5_000, retryLimit: 120_000 };

export type ApplierOptions = {
  /** Called once the applier settles an approval, so its card, its link and its lead are seen to. */
  onChange?: () => void;
  /** Called when the applier stops on an error that applying again can't fix. */
  onError?: (error: unknown) => void;
  now?: () => number;
  timings?: ApplierTimings;
};

/** What became of an approved approval when the applier tried it. */
export type ApplyAttempt =
  /**
   * It's no longer approved. `approval` is how this attempt settled it, applied or stale, or null
   * when something else settled it first.
   */
  | { kind: "settled"; approval: Approval | null }
  /** Slack isn't connected, so nothing about it can be verified until it is. */
  | { kind: "waiting" }
  | Unverified;

/** The longest the applier goes without a pass. */
const MAX_WAIT = 60_000;

/** The longest one read of the facts an approval is judged on may take. */
const READ_MS = 40_000;

/** How many times one attempt reads facts before it gives up on a state that keeps changing. */
const MAX_READS = 2;

/** Starts applying at once, and again whenever `reconsider` is called. */
export function startApplier(
  database: BridgeDatabase,
  reader: FactsReader,
  {
    onChange = () => {},
    onError = () => {},
    now = Date.now,
    timings = defaultApplierTimings,
  }: ApplierOptions = {},
): Applier {
  // The approvals whose last read proved nothing, how many reads in a row did, and when to retry.
  const retries = new Map<string, { count: number; at: number }>();
  const stopping = new AbortController();
  let timer: Timer | undefined;
  let applying: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  function reconsider() {
    if (stopped) return;
    again = true;
    applying ??= applyWhileChanged();
  }

  // A change during a pass earns one more pass, however many changes there were.
  async function applyWhileChanged() {
    try {
      while (again && !stopped) {
        again = false;
        await apply();
      }
    } catch (error) {
      fail(error);
    } finally {
      applying = undefined;
    }
  }

  // Expires the cards whose hour is up, then tries each approved approval, oldest first, unless
  // it's waiting to retry. The next pass comes at the earliest expiry, retry or deadline.
  async function apply() {
    clearTimeout(timer);
    const expired = await database.write((transaction) => expireApprovals(transaction, now()));
    if (expired.length > 0) onChange();
    const open = await database.read((sql) => readAllOpenApprovals(sql));
    for (const id of retries.keys()) {
      if (!open.some((approval) => approval.id === id)) retries.delete(id);
    }
    let next = Infinity;
    for (const approval of open) {
      if (stopped) return;
      if (approval.state === "pending") {
        next = Math.min(next, approval.expiresAt);
        continue;
      }
      const deadline = verifyDeadline(approval);
      const retryAt = retries.get(approval.id)?.at ?? 0;
      if (retryAt > now()) {
        next = Math.min(next, retryAt);
        continue;
      }
      const attempt = await verifyAndApply(database, reader, approval.id, {
        now,
        signal: stopping.signal,
      });
      if (stopped) return;
      switch (attempt.kind) {
        case "settled":
          retries.delete(approval.id);
          if (attempt.approval) onChange();
          break;
        case "waiting":
          retries.delete(approval.id);
          next = Math.min(next, deadline);
          break;
        case "unverified":
          next = Math.min(next, retry(approval, attempt, deadline));
          break;
      }
    }
    timer = setTimeout(reconsider, Math.max(Math.min(next - now(), MAX_WAIT), 0));
  }

  // Backs off from each read in a row that proved nothing, but never past when Slack said to
  // wait, or past the deadline, when the approval goes stale.
  function retry(approval: Approval, unverified: Unverified, deadline: number): number {
    const count = (retries.get(approval.id)?.count ?? 0) + 1;
    const wait = Math.min(timings.retry * 2 ** (count - 1), timings.retryLimit);
    const at = Math.min(Math.max(now() + wait, unverified.retryAt ?? 0), deadline);
    retries.set(approval.id, { count, at });
    console.error(
      `Couldn't check a${approval.number} with Slack and Toy Box, so the bridge will try again: ${unverified.detail}`,
    );
    return at;
  }

  function fail(error: unknown) {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    console.error("Stopped applying approved changes:", error);
    onError(error);
  }

  reconsider();
  return {
    reconsider,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      stopping.abort();
      await applying;
    },
  };
}

/**
 * Applies an approved approval, or marks it stale, once facts read fresh for exactly what it
 * needs say which. One that can't be verified by its deadline, APPLY_VERIFY_MS after the click,
 * goes stale without a read, and each read gives up when `signal` aborts or the deadline comes.
 */
export async function verifyAndApply(
  database: BridgeDatabase,
  reader: FactsReader,
  approvalId: string,
  { now, signal }: { now: () => number; signal: AbortSignal },
): Promise<ApplyAttempt> {
  let fresh: Fresh | null = null;
  for (let reads = 0; ; reads++) {
    const read: Fresh | null = fresh;
    const step: ApplyStep = await database.write((transaction) =>
      takeApplyStep(transaction, approvalId, read, now()),
    );
    if (step.kind !== "read") return step;
    if (reads === MAX_READS) {
      return { kind: "unverified", detail: "what it needs kept changing", retryAt: null };
    }
    const timeout = AbortSignal.timeout(Math.max(Math.min(READ_MS, step.deadline - now()), 0));
    const reading = AbortSignal.any([signal, timeout]);
    const toyBox = await reader.readToyBox(step.toyboxChannelId, reading);
    if (toyBox.kind === "unverified") return toyBox;
    const slack = await reader.readSlack(step.needed, step.ownerIds, reading);
    if (slack.kind === "unverified") return slack;
    fresh = { needed: step.needed, facts: { ...slack.facts, toyBox: toyBox.facts } };
  }
}

/** Facts read for what an approval needed. */
type Fresh = { needed: FactsNeeded; facts: FreshFacts };

type ApplyStep =
  | ApplyAttempt
  /** The approval needs facts read for it, by its deadline. */
  | {
      kind: "read";
      toyboxChannelId: string;
      needed: FactsNeeded;
      ownerIds: string[];
      deadline: number;
    };

/** What an approval is judged on when it needs nothing read, because nothing could save it. */
const nothingRead: FreshFacts = {
  monitored: null,
  publish: null,
  ownerInMonitored: false,
  ownerInPublish: false,
  people: [],
  toyBox: null,
};

/**
 * Settles an approved approval when it can be: as not verified once its deadline has come, and
 * otherwise by judging it against facts read for exactly what it needs now, or against nothing
 * when it needs nothing, because its link or the owner is gone. Asks for a read when there are no
 * such facts, and waits while Slack isn't connected.
 */
async function takeApplyStep(
  transaction: Bun.SQL,
  approvalId: string,
  fresh: Fresh | null,
  at: number,
): Promise<ApplyStep> {
  const approval = await readApproval(transaction, approvalId);
  if (approval?.state !== "approved") return { kind: "settled", approval: null };
  const deadline = verifyDeadline(approval);
  if (at >= deadline) return stale(transaction, approval, "not_verified", at);
  const state = await readSetupState(transaction, approval.toyboxChannelId);
  if (state?.installation.status !== "active") return { kind: "waiting" };
  const needed = factsNeeded(state, approval);
  if (needed && !Bun.deepEquals(fresh?.needed, needed, true)) {
    const ownerIds = await readPersonIds(transaction, needed.owner);
    return { kind: "read", toyboxChannelId: approval.toyboxChannelId, needed, ownerIds, deadline };
  }
  const elsewhere =
    needed !== null &&
    (await linkedElsewhere(transaction, needed.monitored, approval.toyboxChannelId));
  const verdict = judgeApply(state, approval, fresh?.facts ?? nothingRead, elsewhere);
  if (verdict.kind === "stale") return stale(transaction, approval, verdict.reason, at);
  const linkId = await applyPatch(transaction, approval, verdict, at);
  const applied = await recordApplied(transaction, approval, linkId, at);
  if (approval.action === "owner") {
    // Every other open card asks the owner this one replaced.
    const open = await readAllOpenApprovals(transaction);
    await staleApprovals(transaction, open, "owner_changed", at);
  }
  return { kind: "settled", approval: applied };
}

/**
 * Puts exactly an approval's patch in: the link's columns it names, each allowlist entry, or the
 * owner. A link it changes keeps the audiences the verdict approved, and a new one starts active,
 * watching from now. Returns the link's ID.
 */
async function applyPatch(
  transaction: Bun.SQL,
  approval: Approval,
  { approved, routine }: Extract<ApplyVerdict, { kind: "apply" }>,
  at: number,
): Promise<string> {
  const linkId = approval.linkId ?? crypto.randomUUID();
  const columns: Record<string, unknown> = {};
  for (const { field, after } of approval.patch) {
    if (field !== "owner_user_id" && allowlistUser(field) === null) columns[field] = after;
  }
  const audience = JSON.stringify(approved);
  if (approval.action === "link") {
    const link = {
      ...columns,
      id: linkId,
      toybox_channel_id: approval.toyboxChannelId,
      status: "active",
      approved_audience: audience,
      routine_state: routine,
      linked_at_ts: tsAt(at),
      created_at: at,
      updated_at: at,
    };
    await transaction`INSERT INTO links ${transaction(link)}`;
  } else if (Object.keys(columns).length > 0) {
    // A link made active again is suspended for no reason any more.
    const reason = "status" in columns ? { status_reason: null } : {};
    const change = { ...columns, ...reason, approved_audience: audience, updated_at: at };
    await transaction`UPDATE links SET ${transaction(change)} WHERE id = ${linkId}`;
  }
  for (const { field, after } of approval.patch) {
    const userId = allowlistUser(field);
    if (userId !== null) {
      const { label } = after as AllowlistEntry;
      await transaction`
        INSERT INTO allowlist (link_id, user_id, label, added_at)
        VALUES (${linkId}, ${userId}, ${label}, ${at})
        ON CONFLICT (link_id, user_id) DO UPDATE SET label = excluded.label
      `;
    } else if (field === "owner_user_id") {
      await transaction`UPDATE installation SET owner_user_id = ${after as string} WHERE id = 1`;
    }
  }
  return linkId;
}

/** When an approval that couldn't be verified goes stale. */
function verifyDeadline(approval: Approval): number {
  // The schema keeps the time of the click with every approved approval.
  return approval.decidedAt! + APPLY_VERIFY_MS;
}

async function stale(
  transaction: Bun.SQL,
  approval: Approval,
  reason: StaleReason,
  at: number,
): Promise<ApplyStep> {
  const [staled] = await staleApprovals(transaction, [approval], reason, at);
  return { kind: "settled", approval: staled! };
}
