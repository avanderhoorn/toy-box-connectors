import { admissionProblem } from "@links/model/admission";
import {
  admitPoster,
  answerClaim,
  attemptClaim,
  CLAIM_CODE_SPACE,
  claimAttempt,
  claimStatus,
  formatClaimCode,
  hashClaimCode,
  newClaim,
  voidClaim,
  type Claim,
  type ClaimAnswer,
  type ClaimAnswerRefusal,
  type ClaimAttemptOutcome,
  type ClaimMessage,
  type ClaimPost,
  type ClaimState,
  type ClaimVoidReason,
} from "@links/model/claim";
import { queueReaction } from "@outbox/server/database";
import type { SlackTs } from "@slackapi/model/ts";
import type { SlackPerson } from "@slackapi/model/users";
import { readInstallation } from "@slackapi/server/installation";
import { readSlackPersonName, writeSlackPerson } from "@slackapi/server/users";
import { audit, type AuditEntry } from "./audit";

// Stored claims.
//
// The person at a terminal starts a claim, follows it and answers it over the socket, and the
// receiver hands over every message that reads as a claim in its delivery's transaction, before
// the ack. Nothing here calls Slack. Whoever follows a posted claim reads the poster with
// users.info first, and so does a yes, and each step reads the claim and the installation again in
// its own transaction, so a step that lost a race changes nothing.

/** A claim and the ID the terminal follows it by. */
export type StoredClaim = Claim & { id: number };

/** What users.info said about someone, or null when Slack doesn't know them, and when that read began. */
export type PersonLookup = { person: SlackPerson | null; readAt: number };

type ClaimRow = {
  id: number;
  code_hash: string;
  state: ClaimState;
  failed_attempts: number;
  created_at: number;
  expires_at: number;
  posted_by: string | null;
  posted_channel_id: string | null;
  posted_ts: SlackTs | null;
  posted_at: number | null;
  decided_at: number | null;
  void_reason: ClaimVoidReason | null;
};

export type ClaimStart =
  | { kind: "started"; claimId: number; code: string; expiresAt: number }
  | { kind: "refused"; reason: ClaimStartRefusal };

export type ClaimStartRefusal =
  /** Slack isn't installed or rejects the bridge's tokens, so a code couldn't reach it. */
  | "not_connected"
  /** Only reset clears the owner, and only while the bridge is stopped. */
  | "owner_pinned";

/** What the terminal shows while it waits. */
export type ClaimProgress = {
  status: ClaimState | "expired";
  failedAttempts: number;
  expiresAt: number;
  /** Who posted the right code, where and when. */
  post: ClaimPost | null;
  /** The name Slack shows the poster by, once the bridge has read them. */
  posterName: string | null;
  voidReason: ClaimVoidReason | null;
};

export type ClaimAnswerResult =
  | { kind: "confirmed"; ownerUserId: string }
  | { kind: "declined" }
  /** The deadline passed, or a fresh admission check refused the poster, so the claim is void. */
  | { kind: "void"; reason: ClaimVoidReason }
  | { kind: "refused"; reason: ClaimAnswerRefusal | "unknown_claim" | ClaimStartRefusal };

/** Starts a claim with a new code, voiding any claim still open. Refused once an owner is pinned. */
export async function startClaim(transaction: Bun.SQL, now: number): Promise<ClaimStart> {
  const installation = await readInstallation(transaction);
  if (installation?.status !== "active") return { kind: "refused", reason: "not_connected" };
  if (installation.ownerUserId !== null) return { kind: "refused", reason: "owner_pinned" };
  const open = await readOpenClaim(transaction);
  if (open) {
    const reason = claimStatus(open, now) === "expired" ? "expired" : "replaced";
    await saveClaim(transaction, voidClaim(open, reason, now));
    await audit(transaction, { actor: "operator", action: "void_claim", subject: reason }, now);
  }
  const code = formatClaimCode(randomCodeValue());
  const claim = newClaim(hashClaimCode(code), now);
  const [row] = await transaction<{ id: number }[]>`
    INSERT INTO claims ${transaction(claimColumns(claim))} RETURNING id
  `;
  await audit(transaction, { actor: "operator", action: "start_claim" }, now);
  return { kind: "started", claimId: row!.id, code, expiresAt: claim.expiresAt };
}

/** The claim the terminal follows, as it stands at `now`, or null when there's no such claim. */
export async function readClaimProgress(
  sql: Bun.SQL,
  claimId: number,
  now: number,
): Promise<ClaimProgress | null> {
  const claim = await readStoredClaim(sql, claimId);
  if (!claim) return null;
  return {
    status: claimStatus(claim, now),
    failedAttempts: claim.failedAttempts,
    expiresAt: claim.expiresAt,
    post: claim.post,
    posterName: claim.post && (await readSlackPersonName(sql, claim.post.userId)),
    voidReason: claim.voidReason,
  };
}

/**
 * Runs the admission check on whoever posted the code, from `lookup`, a users.info read of them.
 * Someone it admits is stored, so the terminal can name them and ask, and someone it refuses voids
 * the code. Returns whether the claim changed, which it doesn't when it wasn't waiting for that or
 * Slack isn't connected.
 */
export async function admitClaimPoster(
  transaction: Bun.SQL,
  claimId: number,
  lookup: PersonLookup,
  now: number,
): Promise<boolean> {
  const claim = await readStoredClaim(transaction, claimId);
  const installation = await readInstallation(transaction);
  if (claim?.state !== "posted" || installation?.status !== "active") return false;
  const problem = admissionProblem(claim.post!.userId, lookup.person, installation);
  const admitted = admitPoster(claim, problem, now)!;
  await saveClaim(transaction, admitted);
  if (admitted.state === "admitted") {
    const person = lookup.person!;
    await writeSlackPerson(transaction, person, lookup.readAt);
    await audit(transaction, { actor: "bridge", action: "admit_claim", subject: person.id }, now);
  } else {
    const reason = admitted.voidReason;
    await audit(transaction, { actor: "bridge", action: "void_claim", subject: reason }, now);
  }
  return true;
}

/**
 * Settles an admitted claim with the terminal's answer about who it showed as posting the code. A
 * yes needs `lookup`, a users.info read of the poster begun after the terminal asked. It pins them
 * under the ID Slack gives them only if the admission check still passes on that read, and queues
 * ✅ on their message. A no needs no read and closes the claim, so the operator starts again.
 */
export async function answerStoredClaim(
  transaction: Bun.SQL,
  claimId: number,
  answer: ClaimAnswer,
  lookup: PersonLookup | null,
  now: number,
): Promise<ClaimAnswerResult> {
  const claim = await readStoredClaim(transaction, claimId);
  if (!claim) return { kind: "refused", reason: "unknown_claim" };
  const installation = await readInstallation(transaction);
  if (installation?.status !== "active") return { kind: "refused", reason: "not_connected" };
  if (installation.ownerUserId !== null) return { kind: "refused", reason: "owner_pinned" };
  if (answer.confirm && !lookup) throw new TypeError("A yes needs a fresh read of the poster.");

  const problem =
    answer.confirm && claim.post
      ? admissionProblem(claim.post.userId, lookup!.person, installation)
      : null;
  const outcome = answerClaim(claim, answer, problem, now);
  if (outcome.kind === "refused") return outcome;
  await saveClaim(transaction, outcome.claim);
  // Only an admitted claim is settled, so it names who posted the code.
  const post = outcome.claim.post!;
  switch (outcome.kind) {
    case "confirmed": {
      const person = lookup!.person!;
      await writeSlackPerson(transaction, person, lookup!.readAt);
      await transaction`UPDATE installation SET owner_user_id = ${person.id} WHERE id = 1`;
      await audit(transaction, { actor: "operator", action: "pin_owner", subject: person.id }, now);
      await queueReaction(
        transaction,
        { channelId: post.channelId, ts: post.ts, name: "white_check_mark" },
        now,
      );
      return { kind: "confirmed", ownerUserId: person.id };
    }
    case "declined":
      await audit(
        transaction,
        { actor: "operator", action: "decline_claim", subject: post.userId },
        now,
      );
      return { kind: "declined" };
    case "void": {
      const reason = outcome.claim.voidReason!;
      await audit(transaction, { actor: "bridge", action: "void_claim", subject: reason }, now);
      return { kind: "void", reason };
    }
  }
}

/**
 * Tries a claim message against the open claim, in its delivery's transaction before the ack.
 * The receiver consumes every claim message whatever this returns. Only a live, new post in the
 * exact shape by a person, while Slack is connected and no owner is pinned, is tried. Returns
 * whether the claim changed.
 */
export async function takeClaim(
  transaction: Bun.SQL,
  posted: ClaimMessage,
  now: number,
): Promise<boolean> {
  const attempt = claimAttempt(posted);
  if (!attempt) return false;
  const installation = await readInstallation(transaction);
  if (installation?.status !== "active" || installation.ownerUserId !== null) return false;
  const open = await readOpenClaim(transaction);
  const tried = open && attemptClaim(open, attempt, now);
  if (!tried) return false;
  await saveClaim(transaction, tried.claim);
  for (const entry of attemptAudit[tried.outcome](attempt.userId)) {
    await audit(transaction, entry, now);
  }
  return true;
}

const attemptAudit: Record<ClaimAttemptOutcome, (userId: string) => AuditEntry[]> = {
  posted: (userId) => [{ actor: "bridge", action: "post_claim", subject: userId }],
  missed: (userId) => [{ actor: "bridge", action: "miss_claim", subject: userId }],
  exhausted: (userId) => [
    { actor: "bridge", action: "miss_claim", subject: userId },
    { actor: "bridge", action: "void_claim", subject: "exhausted" },
  ],
  expired: () => [{ actor: "bridge", action: "void_claim", subject: "expired" }],
};

async function readStoredClaim(sql: Bun.SQL, claimId: number): Promise<StoredClaim | null> {
  const [row] = await sql<ClaimRow[]>`SELECT * FROM claims WHERE id = ${claimId}`;
  return row ? claimFromRow(row) : null;
}

async function readOpenClaim(sql: Bun.SQL): Promise<StoredClaim | null> {
  const [row] = await sql<ClaimRow[]>`
    SELECT * FROM claims WHERE state IN ('live', 'posted', 'admitted')
  `;
  return row ? claimFromRow(row) : null;
}

async function saveClaim(transaction: Bun.SQL, claim: StoredClaim): Promise<void> {
  const { id, ...rest } = claim;
  await transaction`UPDATE claims SET ${transaction(claimColumns(rest))} WHERE id = ${id}`;
}

/** A uniformly random code value, by rejecting the few values that would favour low codes. */
function randomCodeValue(): number {
  const limit = Math.floor(2 ** 32 / CLAIM_CODE_SPACE) * CLAIM_CODE_SPACE;
  const values = new Uint32Array(1);
  do {
    crypto.getRandomValues(values);
  } while (values[0]! >= limit);
  return values[0]! % CLAIM_CODE_SPACE;
}

function claimFromRow(row: ClaimRow): StoredClaim {
  return {
    id: row.id,
    codeHash: row.code_hash,
    state: row.state,
    failedAttempts: row.failed_attempts,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    post:
      row.posted_by === null
        ? null
        : {
            userId: row.posted_by,
            channelId: row.posted_channel_id!,
            ts: row.posted_ts!,
            at: row.posted_at!,
          },
    decidedAt: row.decided_at,
    voidReason: row.void_reason,
  };
}

function claimColumns(claim: Claim): Omit<ClaimRow, "id"> {
  return {
    code_hash: claim.codeHash,
    state: claim.state,
    failed_attempts: claim.failedAttempts,
    created_at: claim.createdAt,
    expires_at: claim.expiresAt,
    posted_by: claim.post?.userId ?? null,
    posted_channel_id: claim.post?.channelId ?? null,
    posted_ts: claim.post?.ts ?? null,
    posted_at: claim.post?.at ?? null,
    decided_at: claim.decidedAt,
    void_reason: claim.voidReason,
  };
}
