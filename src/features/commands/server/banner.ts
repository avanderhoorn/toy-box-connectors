// What every answer's banner reads.
//
// The banner and status read the same facts of each link in view: whether it's active, whether the
// bridge has every message, and whether its routines still run their commands. The banner adds the
// posts only a person can settle, and for a lead mid-turn, the waiting status its wake cleared.

import {
  composeBanner,
  type Banner,
  type SlackConnection,
  type UnsettledPost,
} from "@commands/model/banner";
import type { Caller } from "@commands/model/callers";
import type { LinkStatus } from "@commands/model/status";
import { restoreArguments } from "@toybox/model/presence";
import { readToyBoxStream } from "@toybox/server/database";

/** A link in view, with everything status shows of it but what lives outside the database. */
export type LinkInView = Omit<LinkStatus, "following" | "wake">;

type LinkRow = {
  id: string;
  toybox_channel_id: string;
  slack_channel_id: string;
  status: LinkStatus["status"];
  status_reason: string | null;
  requests_routine_id: string;
  routine_state: LinkStatus["routines"][number]["state"];
  coverage: LinkStatus["coverage"];
};

type SeriesRow = {
  link_id: string;
  series: string;
  routine_id: string;
  period: "day" | "week";
  routine_state: LinkStatus["routines"][number]["state"];
};

/**
 * The channel's link, or every link when `channelId` is null, oldest first. A gap still open or
 * under repair reads as repairing ahead of one a repair couldn't finish.
 */
export async function readLinksInView(
  sql: Bun.SQL,
  channelId: string | null,
): Promise<LinkInView[]> {
  const links = await sql<LinkRow[]>`
    SELECT id, toybox_channel_id, slack_channel_id, status, status_reason, requests_routine_id,
      routine_state,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM coverage WHERE link_id = links.id AND state IN ('open', 'repairing')
        ) THEN 'repairing'
        WHEN EXISTS (SELECT 1 FROM coverage WHERE link_id = links.id AND state = 'partial')
          THEN 'partial'
        ELSE 'complete'
      END AS coverage
    FROM links
    WHERE ${channelId} IS NULL OR toybox_channel_id = ${channelId}
    ORDER BY created_at, id
  `;
  if (links.length === 0) return [];
  const series = await sql<SeriesRow[]>`
    SELECT link_id, series, routine_id, period, routine_state FROM link_routines
    WHERE link_id IN ${sql(links.map(({ id }) => id))}
    ORDER BY series
  `;
  return links.map((link) => ({
    id: link.id,
    toyBoxChannelId: link.toybox_channel_id,
    slackChannelId: link.slack_channel_id,
    status: link.status,
    statusReason: link.status_reason,
    coverage: link.coverage,
    routines: [
      {
        series: null,
        routineId: link.requests_routine_id,
        period: null,
        state: link.routine_state,
      },
      ...series
        .filter((routine) => routine.link_id === link.id)
        .map((routine) => ({
          series: routine.series,
          routineId: routine.routine_id,
          period: routine.period,
          state: routine.routine_state,
        })),
    ],
  }));
}

/**
 * Posts that may have reached Slack or landed outside their thread, oldest first. For one channel,
 * these are the posts of its link, its link's requests and its approval cards.
 */
export async function readUnsettledPosts(
  sql: Bun.SQL,
  channelId: string | null,
): Promise<UnsettledPost[]> {
  const posts = await sql<{ number: number; kind: UnsettledPost["kind"]; state: string }[]>`
    SELECT number, kind, state FROM outbox
    WHERE state IN ('delivery_unknown', 'stray') AND (
      ${channelId} IS NULL
      OR link_id IN (SELECT id FROM links WHERE toybox_channel_id = ${channelId})
      OR request_id IN (
        SELECT requests.id FROM requests JOIN links ON links.id = requests.link_id
        WHERE links.toybox_channel_id = ${channelId}
      )
      OR approval_id IN (SELECT id FROM approvals WHERE toybox_channel_id = ${channelId})
    )
    ORDER BY number
  `;
  return posts.map(({ number, kind, state }) => ({
    item: `o${number}`,
    kind,
    state: state === "stray" ? "stray" : "delivery_unknown",
  }));
}

/**
 * The banner that opens an answer to `caller`. Only a lead whose turn began by clearing its
 * waiting status gets it back.
 */
export async function readBanner(
  sql: Bun.SQL,
  caller: Caller,
  { slack, at }: { slack: SlackConnection; at: number },
): Promise<Banner> {
  const links = await readLinksInView(sql, caller.channelId);
  const posts = await readUnsettledPosts(sql, caller.channelId);
  let restore = null;
  if (caller.role === "lead") {
    const { lead } = await readToyBoxStream(sql, caller.channelId);
    if (lead?.state === "working" && lead.restore) restore = restoreArguments(lead.restore, at);
  }
  return composeBanner({ slack, links, posts, restore });
}
