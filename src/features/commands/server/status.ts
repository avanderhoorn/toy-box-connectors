// A lead sees its own link, and a terminal the link --channel names, or every link in every app
// without it. A bridge that hosts only the default app answers as it did before it hosted several,
// and one that hosts several names the app of everything it shows.

import type { BridgeDatabase } from "@bridge/server/database";
import type { CommandAnswer } from "@commands/model/protocol";
import { channelName, permalink, personName } from "@commands/model/slackText";
import {
  presentAppStatuses,
  presentStatus,
  type AppStatus,
  type LinkStatus,
  type SlackState,
  type UnconfirmedPost,
} from "@commands/model/status";
import { readRequest } from "@requests/server/database";
import { readSlackPersonName } from "@slackapi/server/users";
import { decideWake, defaultWakeTimings, isPending, type WakeTimings } from "@wakes/model";
import { readLinkWakes } from "@wakes/server/database";
import { readCallerLink } from "./link";
import type { CommandContext } from "./serve";

/** What status reads in one app the bridge hosts. */
export type StatusSource = {
  name: string;
  database: BridgeDatabase;
  slack: () => SlackState;
  /** The Slack workspace's URL, once Slack has said it, for the links of unconfirmed answers. */
  workspaceUrl: () => string | null;
};

/** Shows the status of `apps`, the one the call runs in or every one. */
export type StatusCommand = (
  apps: readonly StatusSource[],
  context: CommandContext,
) => Promise<CommandAnswer>;

export type StatusCommandOptions = {
  /** Whether the bridge hosts several apps, so status names each one. */
  nameApps: boolean;
  timings?: WakeTimings;
};

type LinkStatusRead = Pick<CommandContext, "channelId" | "at"> &
  Pick<StatusSource, "workspaceUrl"> & { timings: WakeTimings };

type StoredLink = Pick<
  LinkStatus,
  "toyBoxChannelId" | "status" | "statusReason" | "requestMode" | "observe"
> & { id: string; slackChannelId: string };

export function statusCommand({
  nameApps,
  timings = defaultWakeTimings,
}: StatusCommandOptions): StatusCommand {
  return async (apps, { channelId, at }) => {
    const statuses: AppStatus[] = [];
    for (const { name, database, slack, workspaceUrl } of apps) {
      const links = await database.read((sql) =>
        readLinkStatuses(sql, { channelId, at, workspaceUrl, timings }),
      );
      statuses.push({ app: name, slack: slack(), links });
    }
    if (nameApps) {
      return { result: { apps: statuses }, text: presentAppStatuses(statuses, at) };
    }
    const { slack, links } = statuses[0]!;
    const status = { slack, links };
    return { result: status, text: presentStatus(status, at) };
  };
}

/** The caller's link, or every link to a terminal that names no channel. */
async function readLinkStatuses(
  sql: Bun.SQL,
  { channelId, at, workspaceUrl, timings }: LinkStatusRead,
): Promise<LinkStatus[]> {
  const only = channelId === null ? null : (await readCallerLink(sql, channelId)).id;
  const stored = await sql<StoredLink[]>`
    SELECT id, toybox_channel_id AS toyBoxChannelId, slack_channel_id AS slackChannelId,
      status, status_reason AS statusReason, request_mode AS requestMode, observe
    FROM links WHERE ${only} IS NULL OR id = ${only}
    ORDER BY created_at
  `;
  const wakes = await readLinkWakes(sql);
  const shown: LinkStatus[] = [];
  for (const { id, slackChannelId, ...link } of stored) {
    const state = wakes.find((wake) => wake.id === id)!;
    const pending = state.requests.filter(isPending).length;
    const allowed = await sql<{ userId: string }[]>`
      SELECT user_id AS userId FROM allowlist WHERE link_id = ${id} ORDER BY added_at
    `;
    const allowlist: string[] = [];
    for (const { userId } of allowed) {
      allowlist.push(personName(await readSlackPersonName(sql, userId), userId));
    }
    const unconfirmed: UnconfirmedPost[] = [];
    for (const post of await sql<Omit<UnconfirmedPost, "permalink">[]>`
      SELECT number AS post, attempt_started_at AS since, request_id AS request, series,
        scheduled_at AS scheduledAt
      FROM outbox WHERE link_id = ${id} AND state = 'delivery_unknown' ORDER BY number
    `) {
      const request = post.request === null ? null : await readRequest(sql, post.request);
      unconfirmed.push({ ...post, permalink: request && permalink(workspaceUrl(), request) });
    }
    shown.push({
      ...link,
      slackChannel: channelName(null, slackChannelId),
      allowlist,
      pending,
      read: state.requests.length - pending,
      unconfirmed,
      wake: decideWake(at, state, timings),
      lastWake: state.runs[0] ?? null,
    });
  }
  return shown;
}
