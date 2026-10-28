// The inbox command.
//
// Inbox reads and serves the caller's link in one transaction, so what it marks read is exactly
// what it returns. It reports each proposal that ended once, shows each request that wakes the lead
// with every message the request holds and marks it read at that revision, lists the requests the
// lead read and hasn't answered, reports once each one it read that was cancelled or expired, and
// records the read, which ends the link's wake backoff and any stall. Roles, names and files are
// read as they are now, not as they were when someone asked. With no link, it says which open
// proposal would link the channel, if one does.

import type { BridgeDatabase } from "@bridge/server/database";
import type { CommandHandler } from "@commands/model/contract";
import {
  inboxResultSchema,
  listRequests,
  type EndedRequest,
  type InboxResult,
  type inboxContract,
  type ServedRequest,
  type SettingChange,
  type SettingOutcome,
  type WaitingRequest,
} from "@commands/model/inbox";
import { isCancelReason } from "@commands/model/requests";
import {
  oneLine,
  renderSlackText,
  slackReferences,
  withoutLeadingMention,
  type SlackNames,
} from "@commands/model/slackText";
import {
  allowlistUser,
  approvalStates,
  isOpen,
  type Approval,
  type ApprovalState,
  type PatchEntry,
} from "@links/model/approvals";
import { readApproval, saveApproval } from "@links/server/approvals";
import { readChannelLink } from "@links/server/database";
import { reportEnding, serveRequest } from "@requests/model/lifecycle";
import {
  readActiveRequests,
  readUnreportedEndings,
  saveRequest,
  type StoredRequest,
} from "@requests/server/database";
import type { SlackFile } from "@slackapi/model/messages";
import { compareTs, type SlackTs } from "@slackapi/model/ts";
import { currentChannelId, readChannelInfo } from "@slackapi/server/channels";
import { readInstallation } from "@slackapi/server/installation";
import { readSlackPersonName } from "@slackapi/server/users";
import type { WakeScheduler } from "@wakes/server";
import { recordInbox } from "@wakes/server/database";

export type InboxCommandOptions = {
  database: BridgeDatabase;
  wakes: Pick<WakeScheduler, "reconsider">;
  /** The workspace's address from auth.test, such as https://acme.slack.com/, once it's known. */
  workspaceUrl: () => string | null;
};

/** How much of a waiting request's first message its row quotes. */
const SNIPPET_LIMIT = 60;

/** Inbox for the caller's channel, which the lead reads to learn what Slack asked of it. */
export function inboxCommand({
  database,
  wakes,
  workspaceUrl,
}: InboxCommandOptions): CommandHandler<typeof inboxContract> {
  return async ({ limit }, { caller, at }) => {
    const inbox = await database.write(async (transaction) => {
      const names = nameReader(transaction);
      const settings = await reportSettings(transaction, caller.channelId, names, at);
      const [link] = await transaction<{ id: string; slackChannelId: string }[]>`
        SELECT id, slack_channel_id AS slackChannelId FROM links
        WHERE toybox_channel_id = ${caller.channelId}
      `;
      const unlinked = {
        requests: [],
        more: 0,
        waiting: [],
        moreWaiting: 0,
        ended: [],
        moreEnded: 0,
      };
      if (!link) {
        const linkProposal = await readLinkProposal(transaction, caller.channelId);
        return checked({ linked: false, linkProposal, settings, ...unlinked });
      }

      const installation = await readInstallation(transaction);
      const audience: Audience = {
        ownerUserId: installation?.ownerUserId ?? null,
        allowlist:
          (await readChannelLink(transaction, link.slackChannelId))?.allowlist ?? new Set(),
      };
      const reading: Reading = {
        sql: transaction,
        names,
        audience,
        botUserId: installation?.botUserId ?? null,
        workspaceUrl: workspaceUrl(),
      };
      const listed = listRequests(await readActiveRequests(transaction, link.id), limit);
      const requests: ServedRequest[] = [];
      for (const request of listed.pending) {
        requests.push(await servedRequest(reading, request));
        await saveRequest(transaction, serveRequest(request, at));
      }
      const waiting: WaitingRequest[] = [];
      for (const request of listed.waiting) waiting.push(await waitingRequest(reading, request));
      const endings = await reportEndings(reading, link.id, limit, at);
      await recordInbox(transaction, link.id, at);
      const { more, moreWaiting } = listed;
      return checked({
        linked: true,
        linkProposal: null,
        settings,
        requests,
        more,
        waiting,
        moreWaiting,
        ...endings,
      });
    });
    wakes.reconsider();
    return inbox;
  };
}

// What inbox marks read must reach the lead, so a result the contract would refuse rolls back.
function checked(inbox: InboxResult): InboxResult {
  return inboxResultSchema.parse(inbox);
}

/** Who may ask on the caller's link now. */
type Audience = { ownerUserId: string | null; allowlist: ReadonlySet<string> };

/** Everything showing a request reads besides the request. */
type Reading = {
  sql: Bun.SQL;
  names: NameReader;
  audience: Audience;
  botUserId: string | null;
  workspaceUrl: string | null;
};

/**
 * The caller's proposals that ended since inbox last reported them, oldest first, each now
 * reported. Ending means the owner decided it, it expired or it went stale.
 */
async function reportSettings(
  transaction: Bun.SQL,
  channelId: string,
  names: NameReader,
  at: number,
): Promise<SettingOutcome[]> {
  const unreported = await transaction<{ id: string }[]>`
    SELECT id FROM approvals
    WHERE toybox_channel_id = ${channelId} AND reported_at IS NULL
    ORDER BY number
  `;
  const settings: SettingOutcome[] = [];
  for (const { id } of unreported) {
    const approval = await readApproval(transaction, id);
    if (approval === null || !hasEnded(approval)) continue;
    settings.push(await settingOutcome(approval, names));
    await saveApproval(transaction, { ...approval, reportedAt: at });
  }
  return settings;
}

function hasEnded(
  approval: Approval,
): approval is Approval & { state: Exclude<ApprovalState, "pending" | "approved"> } {
  return !isOpen(approval.state);
}

const openStates = approvalStates.filter(isOpen);

/**
 * The newest open proposal to link the caller's channel, which names no link until it applies. The
 * bridge refuses to propose a link for a channel that has one, and unlink voids this one.
 */
async function readLinkProposal(transaction: Bun.SQL, channelId: string): Promise<number | null> {
  const [proposal] = await transaction<{ number: number }[]>`
    SELECT number FROM approvals
    WHERE toybox_channel_id = ${channelId} AND action = 'link'
      AND state IN ${transaction(openStates)}
    ORDER BY number DESC LIMIT 1
  `;
  return proposal?.number ?? null;
}

async function settingOutcome(
  approval: Approval & { state: SettingOutcome["state"] },
  names: NameReader,
): Promise<SettingOutcome> {
  const changes: SettingChange[] = [];
  for (const entry of approval.patch) {
    const change = await settingChange(entry, names);
    if (change !== null) changes.push(change);
  }
  return {
    approval: approval.number,
    action: approval.action,
    state: approval.state,
    owner: await names.person(approval.readSet.ownerUserId),
    decidedBy: approval.decidedBy === null ? null : await names.person(approval.decidedBy),
    staleReason: approval.staleReason,
    changes,
  };
}

/** What one patch entry changes, or null for the requests routine, which inbox doesn't show. */
async function settingChange(
  { field, after }: PatchEntry,
  names: NameReader,
): Promise<SettingChange | null> {
  switch (field) {
    case "slack_channel_id":
      return typeof after === "string"
        ? { kind: "watch", channel: await names.channel(after) }
        : null;
    case "publish_channel_id":
      return typeof after === "string"
        ? { kind: "publish", channel: await names.channel(after) }
        : null;
    case "request_mode":
      return after === "mention" || after === "all" ? { kind: "requests", mode: after } : null;
    case "observe":
      return after === "requesters" || after === "channel"
        ? { kind: "observe", mode: after }
        : null;
    case "owner_user_id":
      return typeof after === "string"
        ? { kind: "owner", person: await names.person(after) }
        : null;
    case "status":
      return after === "active" ? { kind: "resume" } : null;
    default: {
      // Deny applies at once, so a proposal only ever allows someone.
      const userId = allowlistUser(field);
      return userId === null ? null : { kind: "allow", person: await names.person(userId) };
    }
  }
}

async function servedRequest(reading: Reading, request: StoredRequest): Promise<ServedRequest> {
  const { sql, names } = reading;
  const rows = await readRequestMessages(sql, request.id);
  const fetchable = await readFetchableFiles(sql, rows);
  const messages: ServedRequest["messages"] = [];
  for (const row of rows) {
    messages.push({
      ts: row.ts,
      state: messageState(row),
      text: row.text === null ? null : renderSlackText(row.text, await names.in(row.text)),
      files: messageFiles(row).flatMap((file) =>
        fetchable.has(file.id) ? [{ id: file.id, name: file.name, size: file.size }] : [],
      ),
    });
  }
  const latest = rows.at(-1)?.ts ?? request.sourceTs;
  const others = await readThreadOthers(sql, request);
  const earlier = others.filter((ts) => compareTs(ts, latest) < 0).length;
  return {
    id: request.id,
    revision: request.inputRev,
    requester: await requester(reading, request.requesterUserId),
    askedAt: postedAt(request.sourceTs),
    attention: request.attention,
    unverified: request.sourceUnverifiedAt !== null,
    permalink: permalink(reading.workspaceUrl, request),
    messages,
    earlier,
    later: others.length - earlier,
  };
}

async function waitingRequest(
  reading: Reading,
  request: StoredRequest & { state: WaitingRequest["state"] },
): Promise<WaitingRequest> {
  const rows = await readRequestMessages(reading.sql, request.id);
  return {
    id: request.id,
    revision: request.servedRev,
    requester: await requester(reading, request.requesterUserId),
    state: request.state,
    askedAt: postedAt(request.sourceTs),
    heldAt: request.heldAt,
    snippet: await snippet(reading, rows),
  };
}

/**
 * The requests the lead read that were cancelled or expired since inbox last said so, oldest first
 * and up to `limit`, each now reported. Each says who asked and why it ended, never what they said.
 */
async function reportEndings(
  { sql, names }: Reading,
  linkId: string,
  limit: number,
  at: number,
): Promise<Pick<InboxResult, "ended" | "moreEnded">> {
  const unreported = await readUnreportedEndings(sql, linkId);
  const ended: EndedRequest[] = [];
  for (const request of unreported.slice(0, limit)) {
    const reported = reportEnding(request, at);
    await saveRequest(sql, reported);
    ended.push({
      id: reported.id,
      requester: await names.person(reported.requesterUserId),
      state: reported.state,
      reason: isCancelReason(reported.closedReason) ? reported.closedReason : null,
    });
  }
  return { ended, moreEnded: Math.max(0, unreported.length - limit) };
}

/**
 * The requester as they stand now, which can differ from when they asked. Their role is what the
 * outbox checks before it posts a reply, so a reply to someone not allowed is refused.
 */
async function requester(
  { names, audience }: Reading,
  userId: string,
): Promise<ServedRequest["requester"]> {
  const role =
    userId === audience.ownerUserId
      ? "owner"
      : audience.allowlist.has(userId)
        ? "allowed"
        : "not_allowed";
  return { ...(await names.person(userId)), role };
}

/** The start of the request's first message that has text, without the bot's mention it opens with. */
async function snippet(
  { names, botUserId }: Reading,
  rows: readonly MessageRow[],
): Promise<string> {
  const text = rows.find((row) => row.text !== null)?.text ?? null;
  if (text === null) return "";
  const asked = botUserId === null ? text : withoutLeadingMention(text, botUserId);
  return oneLine(renderSlackText(asked, await names.in(asked)), SNIPPET_LIMIT);
}

type MessageRow = {
  ts: SlackTs;
  text: string | null;
  files: string | null;
  edited_ts: SlackTs | null;
  deleted: number;
  withdrawn: number;
};

/** A request's messages, oldest first. */
async function readRequestMessages(sql: Bun.SQL, requestId: number): Promise<MessageRow[]> {
  const rows = await sql<MessageRow[]>`
    SELECT messages.ts, messages.text, messages.files, messages.edited_ts, messages.deleted,
      messages.withdrawn
    FROM request_messages
    JOIN messages
      ON messages.channel_id = request_messages.channel_id AND messages.ts = request_messages.ts
    WHERE request_messages.request_id = ${requestId}
  `;
  return rows.sort((left, right) => compareTs(left.ts, right.ts));
}

function messageState({
  deleted,
  withdrawn,
  edited_ts,
}: MessageRow): ServedRequest["messages"][number]["state"] {
  if (withdrawn === 1) return "withdrawn";
  if (deleted === 1) return "deleted";
  return edited_ts === null ? "posted" : "edited";
}

function messageFiles(row: MessageRow): SlackFile[] {
  return row.files === null ? [] : (JSON.parse(row.files) as SlackFile[]);
}

// A message keeps naming a file Slack deleted, but the ledger forgets it, so only the files the
// ledger still has can be fetched.
async function readFetchableFiles(sql: Bun.SQL, rows: readonly MessageRow[]): Promise<Set<string>> {
  const ids = rows.flatMap((row) => messageFiles(row).map((file) => file.id));
  if (ids.length === 0) return new Set();
  const files = await sql<{ file_id: string }[]>`
    SELECT file_id FROM files WHERE file_id IN ${sql(ids)}
  `;
  return new Set(files.map((file) => file.file_id));
}

/** The ts of every message in the request's thread that's still there and isn't the request's. */
async function readThreadOthers(sql: Bun.SQL, request: StoredRequest): Promise<SlackTs[]> {
  const others = await sql<{ ts: SlackTs }[]>`
    SELECT ts FROM messages
    WHERE channel_id = ${request.channelId} AND deleted = 0
      AND (ts = ${request.rootTs} OR thread_ts = ${request.rootTs})
      AND NOT EXISTS (
        SELECT 1 FROM request_messages
        WHERE request_messages.request_id = ${request.id}
          AND request_messages.channel_id = messages.channel_id
          AND request_messages.ts = messages.ts
      )
  `;
  return others.map((message) => message.ts);
}

/** The request's first message in Slack, opened in its thread when it's a reply. */
function permalink(workspaceUrl: string | null, request: StoredRequest): string | null {
  if (workspaceUrl === null) return null;
  const workspace = workspaceUrl.endsWith("/") ? workspaceUrl : `${workspaceUrl}/`;
  const message = `${workspace}archives/${request.channelId}/p${request.sourceTs.replace(".", "")}`;
  return request.sourceTs === request.rootTs ? message : `${message}?thread_ts=${request.rootTs}`;
}

/** When Slack says a message was posted, to the second. */
function postedAt(ts: SlackTs): number {
  return Number(ts.slice(0, ts.indexOf("."))) * 1000;
}

type NameReader = ReturnType<typeof nameReader>;

/** Reads each name once, since one inbox can name the same people and channels many times. */
function nameReader(sql: Bun.SQL) {
  const people = new Map<string, string | null>();
  const channels = new Map<string, string | null>();

  async function personName(userId: string): Promise<string | null> {
    if (!people.has(userId)) people.set(userId, await readSlackPersonName(sql, userId));
    return people.get(userId) ?? null;
  }

  async function channelName(channelId: string): Promise<string | null> {
    if (!channels.has(channelId)) {
      const info = await readChannelInfo(sql, await currentChannelId(sql, channelId));
      channels.set(channelId, info?.facts.name ?? null);
    }
    return channels.get(channelId) ?? null;
  }

  return {
    async person(userId: string) {
      return { userId, name: await personName(userId) };
    },
    async channel(channelId: string) {
      return { id: channelId, name: await channelName(channelId) };
    },
    /** The names of the people and channels `text` refers to that the bridge has stored. */
    async in(text: string): Promise<SlackNames> {
      const references = slackReferences(text);
      const names = { people: new Map<string, string>(), channels: new Map<string, string>() };
      for (const userId of references.people) {
        const name = await personName(userId);
        if (name !== null) names.people.set(userId, name);
      }
      for (const channelId of references.channels) {
        const name = await channelName(channelId);
        if (name !== null) names.channels.set(channelId, name);
      }
      return names;
    },
  };
}
