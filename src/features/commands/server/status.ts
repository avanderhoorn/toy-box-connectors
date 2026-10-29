// A lead sees its own link, and a terminal the link --channel names, or every link without it.

import type { BridgeDatabase } from "@bridge/server/database";
import { channelName, permalink, personName } from "@commands/model/slackText";
import {
  presentStatus,
  type LinkStatus,
  type SlackState,
  type UnconfirmedPost,
} from "@commands/model/status";
import { readRequest } from "@requests/server/database";
import { readSlackPersonName } from "@slackapi/server/users";
import { decideWake, defaultWakeTimings, isPending, type WakeTimings } from "@wakes/model";
import { readLinkWakes } from "@wakes/server/database";
import { readCallerLink } from "./link";
import type { CommandHandler } from "./serve";

export type StatusCommandOptions = {
  database: BridgeDatabase;
  slack: () => SlackState;
  /** The Slack workspace's URL, once Slack has said it, for the links of unconfirmed answers. */
  workspaceUrl: () => string | null;
  timings?: WakeTimings;
};

type StoredLink = Pick<
  LinkStatus,
  "toyBoxChannelId" | "status" | "statusReason" | "requestMode" | "observe"
> & { id: string; slackChannelId: string };

export function statusCommand({
  database,
  slack,
  workspaceUrl,
  timings = defaultWakeTimings,
}: StatusCommandOptions): CommandHandler<"status"> {
  return async (_input, { caller, at }) => {
    const links = await database.read(async (sql) => {
      const only = caller.channelId === null ? null : (await readCallerLink(sql, caller)).id;
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
        const allowed = await sql<{ userId: string; label: string | null }[]>`
          SELECT user_id AS userId, label FROM allowlist WHERE link_id = ${id} ORDER BY added_at
        `;
        const allowlist: string[] = [];
        for (const { userId, label } of allowed) {
          allowlist.push(personName((await readSlackPersonName(sql, userId)) ?? label, userId));
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
    });
    const status = { slack: slack(), links };
    return { result: status, text: presentStatus(status, at) };
  };
}
