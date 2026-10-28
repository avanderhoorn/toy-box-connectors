// The status command.
//
// A lead sees its own link, and a terminal the link --channel names, or every link without it. The
// wake decision is the scheduler's, made again from what's stored now.

import type { BridgeDatabase } from "@bridge/server/database";
import { NAME_LIMIT, oneLine, personName } from "@commands/model/slackText";
import {
  presentStatus,
  type LinkStatus,
  type SlackState,
  type Status,
} from "@commands/model/status";
import { readSlackPersonName } from "@slackapi/server/users";
import { decideWake, defaultWakeTimings, isPending, type WakeTimings } from "@wakes/model";
import { readLinkWakes } from "@wakes/server/database";
import { readCallerLink } from "./link";
import type { CommandHandler } from "./serve";

export type StatusCommandOptions = {
  database: BridgeDatabase;
  slack: () => SlackState;
  timings?: WakeTimings;
};

type StoredLink = Pick<
  LinkStatus,
  "toyBoxChannelId" | "status" | "statusReason" | "requestMode" | "observe"
> & { id: string; slackChannelId: string; channelName: string | null };

export function statusCommand({
  database,
  slack,
  timings = defaultWakeTimings,
}: StatusCommandOptions): CommandHandler<"status"> {
  return async (_input, { caller, at }) => {
    const status = await database.read(async (sql): Promise<Status> => {
      const only = caller.channelId === null ? null : (await readCallerLink(sql, caller)).id;
      const links = await sql<StoredLink[]>`
        SELECT links.id, toybox_channel_id AS toyBoxChannelId, slack_channel_id AS slackChannelId,
          channel_info.name AS channelName, status, status_reason AS statusReason,
          request_mode AS requestMode, observe
        FROM links LEFT JOIN channel_info ON channel_info.channel_id = links.slack_channel_id
        ORDER BY links.created_at
      `;
      const wakes = await readLinkWakes(sql);
      const shown: LinkStatus[] = [];
      for (const { id, slackChannelId, channelName, ...link } of links) {
        if (only !== null && id !== only) continue;
        const state = wakes.find((wake) => wake.id === id)!;
        const pending = state.requests.filter(isPending).length;
        shown.push({
          ...link,
          slackChannel: `#${oneLine(channelName ?? slackChannelId, NAME_LIMIT)}`,
          allowlist: await readAllowlist(sql, id),
          pending,
          read: state.requests.length - pending,
          wake: decideWake(at, state, timings),
          lastWake: state.runs[0] ?? null,
        });
      }
      return { slack: slack(), links: shown };
    });
    return { result: status, text: presentStatus(status, at) };
  };
}

async function readAllowlist(sql: Bun.SQL, linkId: string): Promise<string[]> {
  const people = await sql<{ userId: string; label: string | null }[]>`
    SELECT user_id AS userId, label FROM allowlist WHERE link_id = ${linkId} ORDER BY added_at
  `;
  const names: string[] = [];
  for (const { userId, label } of people) {
    names.push(personName((await readSlackPersonName(sql, userId)) ?? label, userId));
  }
  return names;
}
