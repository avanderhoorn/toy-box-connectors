import { removeLocalCopies } from "@activity/server/files";
import type { BridgeDatabase } from "@bridge/server/database";
import {
  reverses,
  type Approval,
  type LinkField,
  type LinkStatus,
  type Narrowing,
  type PatchEntry,
} from "@links/model/approvals";
import type { ApprovedAudience } from "@links/model/audience";
import { forgetLinkOutbox } from "@outbox/server/database";
import { readActiveRequests, type StoredRequest } from "@requests/server/database";
import { cancelStoredRequest } from "@requests/server/lifecycle";
import { readInstallation } from "@slackapi/server/installation";
import { readPersonIds } from "@slackapi/server/users";
import {
  expireApprovals,
  forgetUnlinkedApprovals,
  readAllOpenApprovals,
  readOpenApprovals,
  staleApprovals,
} from "./approvals";
import { audit, auditPatch } from "./audit";
import { purgeForUnlink } from "./purge";
import type { SetupCaller } from "./setup";

// Narrowing.
//
// A change that narrows who can make the lead act, or who reads what it says, needs no click: it
// applies at once, in the transaction that decides it, with an audit entry. It also voids every
// open card it reverses, so a value that changes and changes back before the owner clicks can't
// carry an old card through. Each acts on the link of the Toy Box channel its caller resolved to.

export type PauseOutcome =
  | { kind: "refused"; reason: "not_linked" }
  /** The link was paused or suspended already, and no card would resume it. */
  | { kind: "unchanged"; status: "paused" | "suspended" }
  /**
   * The link is paused, or stays suspended, which stops it already and says why, and the cards
   * that would resume it are void. Pausing an active link voids its other cards too.
   */
  | { kind: "paused"; status: "paused" | "suspended"; voided: Approval[] };

export type DenyOutcome =
  | { kind: "refused"; reason: "not_linked" | "owner" }
  /** The person wasn't allowed, asked nothing still open, and no card would allow them. */
  | { kind: "unchanged" }
  /**
   * Whether the person was taken off the allowlist, the cards voided that would allow them or
   * hand them ownership, and the numbers of the requests of theirs that were cancelled.
   */
  | { kind: "denied"; removed: boolean; voided: Approval[]; cancelled: number[] };

export type UnlinkOutcome =
  | { kind: "refused"; reason: "not_linked" }
  /**
   * The link that went, or null when there was none but a card that would make one, the cards
   * voided, and the numbers of the requests that were cancelled.
   */
  | { kind: "unlinked"; linkId: string | null; voided: Approval[]; cancelled: number[] };

/**
 * Pauses the Toy Box channel's link, which stops its lead acting in Slack until the owner approves
 * resume, and voids every card that would resume it. A link the bridge suspended stays suspended,
 * since that stops it already and says what ends it. Pausing an active link stales its other cards
 * too, as each was decided against the link's status.
 */
export async function pauseLink(
  database: BridgeDatabase,
  caller: SetupCaller,
  at: number,
): Promise<PauseOutcome> {
  return database.write(async (transaction) => {
    await expireApprovals(transaction, at);
    const link = await readLink(transaction, caller.channelId);
    if (!link) return { kind: "refused", reason: "not_linked" };
    const status = link.status === "suspended" ? "suspended" : "paused";
    const reversed = await readReversed(transaction, {
      kind: "pause",
      toyboxChannelId: caller.channelId,
    });
    if (link.status !== "active" && !reversed.length) return { kind: "unchanged", status };
    await audit(transaction, { actor: caller.role, action: "pause", linkId: link.id }, at);
    const voided = await staleApprovals(transaction, reversed, "reversed", at);
    if (link.status === "active") {
      await transaction`
        UPDATE links SET status = 'paused', status_reason = NULL, updated_at = ${at}
        WHERE id = ${link.id}
      `;
      const open = await readOpenApprovals(transaction, link.id);
      voided.push(...(await staleApprovals(transaction, open, "link_changed", at)));
    }
    return { kind: "paused", status, voided };
  });
}

/**
 * Denies a person, by every ID they're known by, on the Toy Box channel's link: they're taken off
 * its allowlist, the requests they asked of its lead are cancelled, and every card that would allow
 * them is voided. So is every card that would hand them ownership, whichever Toy Box channel asked,
 * since the owner can make every link's lead act. The owner can't be denied. A channel without a
 * link has no one to deny, but can still void those ownership cards.
 */
export async function denyPerson(
  database: BridgeDatabase,
  caller: SetupCaller,
  userId: string,
  at: number,
): Promise<DenyOutcome> {
  return database.write(async (transaction) => {
    await expireApprovals(transaction, at);
    const userIds = await readPersonIds(transaction, userId);
    const owner = (await readInstallation(transaction))?.ownerUserId ?? null;
    if (owner !== null && userIds.includes(owner)) return { kind: "refused", reason: "owner" };
    const link = await readLink(transaction, caller.channelId);
    const reversed = await readReversed(transaction, {
      kind: "deny",
      toyboxChannelId: caller.channelId,
      userIds,
    });
    if (!link && !reversed.length) return { kind: "refused", reason: "not_linked" };
    const allowed = link ? await readAllowed(transaction, link.id, userIds) : [];
    const asked = link
      ? (await readActiveRequests(transaction, link.id)).filter((request) =>
          userIds.includes(request.requesterUserId),
        )
      : [];
    if (!allowed.length && !reversed.length && !asked.length) return { kind: "unchanged" };
    await audit(
      transaction,
      { actor: caller.role, action: "deny", linkId: link?.id ?? null, subject: userIds[0] },
      at,
    );
    if (link) await removePerson(transaction, link.id, allowed, asked, at);
    const voided = await staleApprovals(transaction, reversed, "reversed", at);
    const cancelled = asked.map((request) => request.id);
    return { kind: "denied", removed: allowed.length > 0, voided, cancelled };
  });
}

/**
 * Unlinks the Toy Box channel. Its link goes, with what the bridge keeps for it, its requests are
 * cancelled and every card for it is voided, a new link's included. What Slack may still settle,
 * and the removals the bridge owes, stay without their text until Slack settles them. The local
 * copies of the link's files go once the transaction commits. A channel without a link can still
 * unlink to void a card that would make one.
 */
export async function unlinkChannel(
  database: BridgeDatabase,
  caller: SetupCaller,
  at: number,
  filesFolder: string,
): Promise<UnlinkOutcome> {
  const { outcome, copies } = await database.write(async (transaction) => {
    await expireApprovals(transaction, at);
    const link = await readLink(transaction, caller.channelId);
    const reversed = await readReversed(transaction, {
      kind: "unlink",
      toyboxChannelId: caller.channelId,
    });
    if (!link && !reversed.length) {
      return { outcome: { kind: "refused", reason: "not_linked" } as const, copies: [] };
    }
    await audit(
      transaction,
      { actor: caller.role, action: "unlink", linkId: link?.id ?? null },
      at,
    );
    const voided = await staleApprovals(transaction, reversed, "reversed", at);
    const requests = link ? await readActiveRequests(transaction, link.id) : [];
    for (const request of requests) {
      await cancelStoredRequest(transaction, request, "link_removed", at);
    }
    let copies: string[] = [];
    if (link) {
      await forgetLinkOutbox(transaction, link.id, at);
      copies = await purgeForUnlink(transaction, link);
      await forgetUnlinkedApprovals(transaction, at);
    }
    const cancelled = requests.map((request) => request.id);
    const unlinked = { kind: "unlinked", linkId: link?.id ?? null, voided, cancelled } as const;
    return { outcome: unlinked, copies };
  });
  await removeLocalCopies(filesFolder, copies);
  return outcome;
}

/**
 * Applies a set that only narrows `linkId`'s settings, audits each field it changes, and voids
 * the cards that change one of them. Returns the cards it voided. Publishing back to the watched
 * channel puts posts where the owner approved the audience when the link was made, so that's the
 * publish audience every later read is judged against.
 */
export async function narrowSettings(
  transaction: Bun.SQL,
  caller: SetupCaller,
  linkId: string,
  patch: readonly PatchEntry[],
  now: number,
): Promise<Approval[]> {
  const columns: Record<string, unknown> = {};
  for (const entry of patch) columns[entry.field] = entry.after;
  if ("publish_channel_id" in columns) {
    const [link] = await transaction<{ approved_audience: string }[]>`
      SELECT approved_audience FROM links WHERE id = ${linkId}
    `;
    const approved = JSON.parse(link!.approved_audience) as ApprovedAudience;
    const audience: ApprovedAudience = {
      monitored: approved.monitored,
      publish: approved.monitored,
    };
    columns.approved_audience = JSON.stringify(audience);
  }
  await transaction`
    UPDATE links SET ${transaction({ ...columns, updated_at: now })} WHERE id = ${linkId}
  `;
  await auditPatch(transaction, { actor: caller.role, action: "set", linkId }, patch, now);
  const fields = patch.map((entry) => entry.field as LinkField);
  return voidReversed(transaction, { kind: "set", toyboxChannelId: caller.channelId, fields }, now);
}

/** Voids every open card `narrowing` reverses, and returns them as they're stored now. */
export async function voidReversed(
  transaction: Bun.SQL,
  narrowing: Narrowing,
  now: number,
): Promise<Approval[]> {
  return staleApprovals(transaction, await readReversed(transaction, narrowing), "reversed", now);
}

/** The open cards `narrowing` reverses, whichever link they're for or none, oldest first. */
async function readReversed(sql: Bun.SQL, narrowing: Narrowing): Promise<Approval[]> {
  const open = await readAllOpenApprovals(sql);
  return open.filter((approval) => reverses(narrowing, approval));
}

type NarrowedLink = { id: string; status: LinkStatus; slackChannelId: string };

/** The link a Toy Box channel has, or null when it has none. */
async function readLink(sql: Bun.SQL, toyboxChannelId: string): Promise<NarrowedLink | null> {
  const [link] = await sql<NarrowedLink[]>`
    SELECT id, status, slack_channel_id AS slackChannelId FROM links
    WHERE toybox_channel_id = ${toyboxChannelId}
  `;
  return link ?? null;
}

/** Which of the IDs `userIds` a link allows. */
async function readAllowed(
  sql: Bun.SQL,
  linkId: string,
  userIds: readonly string[],
): Promise<string[]> {
  const allowed = await sql<{ user_id: string }[]>`
    SELECT user_id FROM allowlist WHERE link_id = ${linkId} AND user_id IN ${sql(userIds)}
    ORDER BY user_id
  `;
  return allowed.map((entry) => entry.user_id);
}

/**
 * Takes a person's IDs off a link's allowlist and cancels the requests they asked of its lead, as
 * denying them does and the membership check does for someone Slack no longer admits.
 */
async function removePerson(
  transaction: Bun.SQL,
  linkId: string,
  allowed: readonly string[],
  asked: readonly StoredRequest[],
  now: number,
): Promise<void> {
  if (allowed.length) {
    await transaction`
      DELETE FROM allowlist WHERE link_id = ${linkId} AND user_id IN ${transaction(allowed)}
    `;
  }
  for (const request of asked) {
    await cancelStoredRequest(transaction, request, "requester_denied", now);
  }
}
