// A lead sees its own link, and a terminal the link --channel names, or every link in every app
// without it. A bridge that hosts only the default app answers as it did before it hosted several,
// and one that hosts several names the app of everything it shows. Each link's channels go by the
// names Slack and Toy Box give them, or by their IDs when a name doesn't come in time. Every name is
// asked at once, after status reads bridge.db, so waiting for one never holds up the bridge or
// changes what else status shows.

import type { BridgeDatabase } from "@bridge/server/database";
import type { CommandAnswer } from "@commands/model/protocol";
import { channelName, permalink, personName, toyBoxChannelName } from "@commands/model/slackText";
import {
  presentAppStatuses,
  presentStatus,
  type AppStatus,
  type LinkStatus,
  type SlackState,
  type UnconfirmedPost,
} from "@commands/model/status";
import { readRequest } from "@requests/server/database";
import type { BotClient } from "@slackapi/server/botClient";
import { fetchChannelFacts } from "@slackapi/server/channels";
import { readSlackPersonName } from "@slackapi/server/users";
import { readToyBoxChannel } from "@toybox/server/api";
import { decideWake, defaultWakeTimings, isPending, type WakeTimings } from "@wakes/model";
import { readLinkWakes } from "@wakes/server/database";
import { sleep } from "@/shared/sleep";
import { readCallerLink } from "./link";
import type { CommandContext } from "./serve";

/** What status reads in one app the bridge hosts. */
export type StatusSource = {
  name: string;
  database: BridgeDatabase;
  slack: () => SlackState;
  /** The app's bot, which names its links' Slack channels, or null without its tokens. */
  bot: BotClient | null;
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
  /** The Toy Box that names each link's Toy Box channel. */
  toyBoxOrigin: URL;
  /** How long status waits for the channels' names before it shows the rest by their IDs. */
  nameTimeoutMs?: number;
  timings?: WakeTimings;
};

/** A link's status before its channels are named. */
type UnnamedLink = Omit<LinkStatus, "toyBoxChannel" | "slackChannel">;

/** An app's status before its links' channels are named. */
type UnnamedStatus = { app: StatusSource; slack: SlackState; links: UnnamedLink[] };

type LinkStatusRead = Pick<CommandContext, "channelId" | "at"> &
  Pick<StatusSource, "workspaceUrl"> & { timings: WakeTimings };

type StoredLink = Pick<
  LinkStatus,
  "toyBoxChannelId" | "slackChannelId" | "status" | "statusReason" | "requestMode" | "observe"
> & { id: string };

export function statusCommand({
  nameApps,
  toyBoxOrigin,
  nameTimeoutMs = 2_000,
  timings = defaultWakeTimings,
}: StatusCommandOptions): StatusCommand {
  return async (apps, { channelId, at }) => {
    const read: UnnamedStatus[] = [];
    for (const app of apps) {
      const { database, slack, workspaceUrl } = app;
      const links = await database.read((sql) =>
        readLinkStatuses(sql, { channelId, at, workspaceUrl, timings }),
      );
      read.push({ app, slack: slack(), links });
    }
    const statuses = await nameChannels(read, toyBoxOrigin, nameTimeoutMs);
    if (nameApps) {
      return { result: { apps: statuses }, text: presentAppStatuses(statuses, at) };
    }
    const { slack, links } = statuses[0]!;
    const status = { slack, links };
    return { result: status, text: presentStatus(status, at) };
  };
}

/**
 * Each app's status with its links' channels named, asking for every name at once. Slack is asked
 * only while the app is connected, as its outbox posts only then.
 */
async function nameChannels(
  read: readonly UnnamedStatus[],
  toyBoxOrigin: URL,
  timeoutMs: number,
): Promise<AppStatus[]> {
  const deadline = new AbortController();
  const late = sleep(timeoutMs, deadline.signal).then(() => null);
  // A lookup that fails or misses the deadline names nothing, and runs on unheeded until its own
  // timeout.
  const inTime = <Answer>(lookup: Promise<Answer>) =>
    Promise.race([lookup.catch(() => null), late]);
  try {
    return await Promise.all(
      read.map(async ({ app, slack, links }) => {
        const bot = slack.connection === "connected" ? app.bot : null;
        const named = links.map(async ({ toyBoxChannelId, slackChannelId, ...link }) => {
          const [toyBox, facts] = await Promise.all([
            inTime(readToyBoxChannel(toyBoxOrigin, toyBoxChannelId)),
            bot &&
              inTime(
                bot.call("conversations.info", (client) =>
                  fetchChannelFacts(client, slackChannelId),
                ),
              ),
          ]);
          const slackName = facts?.kind === "ok" ? facts.result?.name : null;
          return {
            toyBoxChannelId,
            toyBoxChannel: toyBoxChannelName(toyBox?.name, toyBoxChannelId),
            slackChannelId,
            slackChannel: channelName(slackName, slackChannelId),
            ...link,
          };
        });
        return { app: app.name, slack, links: await Promise.all(named) };
      }),
    );
  } finally {
    deadline.abort();
  }
}

/** The caller's link, or every link to a terminal that names no channel. */
async function readLinkStatuses(
  sql: Bun.SQL,
  { channelId, at, workspaceUrl, timings }: LinkStatusRead,
): Promise<UnnamedLink[]> {
  const only = channelId === null ? null : (await readCallerLink(sql, channelId)).id;
  const stored = await sql<StoredLink[]>`
    SELECT id, toybox_channel_id AS toyBoxChannelId, slack_channel_id AS slackChannelId,
      status, status_reason AS statusReason, request_mode AS requestMode, observe
    FROM links WHERE ${only} IS NULL OR id = ${only}
    ORDER BY created_at
  `;
  const wakes = await readLinkWakes(sql);
  const shown: UnnamedLink[] = [];
  for (const { id, ...link } of stored) {
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
