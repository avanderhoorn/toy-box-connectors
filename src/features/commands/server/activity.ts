// Activity serves the messages that changed after a link's digest cursor a page at a time, and
// records how far it served. mark-read moves the cursor no further than that, so a lead can't mark
// read what it never saw, and a digest that never finished is served again.

import type { BridgeDatabase } from "@bridge/server/database";
import { threadReference } from "@commands/model";
import { presentActivity, type Activity, type ActivityThread } from "@commands/model/activity";
import { CommandRefusedError } from "@commands/model/protocol";
import { permalink } from "@commands/model/slackText";
import { findPostThreads } from "@outbox/server/threads";
import { compareTs } from "@slackapi/model/ts";
import { messageFromRow, readPersonNames, type MessageRow } from "./inbox";
import { readCallerLink } from "./link";
import type { CommandHandler } from "./serve";

export type ActivityCommandOptions = {
  database: BridgeDatabase;
  /** The Slack workspace's URL, once Slack has said it, for permalinks. */
  workspaceUrl: () => string | null;
};

type ChangedMessage = MessageRow & { seq: number; rootTs: string };

export function activityCommand({
  database,
  workspaceUrl,
}: ActivityCommandOptions): CommandHandler<"activity"> {
  return async ({ limit }, { channelId, at }) => {
    const activity = await database.write(async (transaction): Promise<Activity> => {
      const link = await readCallerLink(transaction, channelId);
      // A message shows once, as its latest change left it. One the bridge keeps no text for never
      // shows, and mark-read passes it with the rest.
      const unread = await transaction<ChangedMessage[]>`
        SELECT c.seq, m.ts, coalesce(m.thread_ts, m.ts) AS rootTs, m.user_id AS userId,
          m.author_role AS role, m.edited_ts IS NOT NULL AS edited, m.text
        FROM changes c
        JOIN messages m ON m.channel_id = c.channel_id AND m.ts = c.ts AND m.updated_seq = c.seq
        LEFT JOIN cursors r ON r.link_id = ${link.id}
        WHERE c.channel_id = ${link.slackChannelId} AND c.seq > coalesce(r.through_seq, 0)
          AND m.text IS NOT NULL
        ORDER BY c.seq
      `;
      const page = unread.slice(0, limit);
      const through = page.at(-1)?.seq ?? null;
      const empty = { channel: link.channel, threads: [], through, more: 0 };
      if (through === null) return empty;
      await transaction`
        INSERT INTO cursors (link_id, served_through_seq) VALUES (${link.id}, ${through})
        ON CONFLICT (link_id) DO UPDATE SET served_through_seq = excluded.served_through_seq
      `;
      const names = await readPersonNames(transaction, page);
      const url = workspaceUrl();
      const threads = new Map<string, ActivityThread>();
      const postable = await findPostThreads(transaction, link, [
        ...new Set(page.map(({ rootTs }) => rootTs)),
      ]);
      page.sort((a, b) => compareTs(a.rootTs, b.rootTs) || compareTs(a.ts, b.ts));
      for (const { rootTs, ...message } of page) {
        const postThread = postable.get(rootTs);
        const thread = threads.get(rootTs) ?? {
          reference: postThread ? threadReference(postThread) : null,
          startedAt: Number.parseInt(rootTs, 10) * 1000,
          permalink: permalink(url, { channelId: link.slackChannelId, sourceTs: rootTs, rootTs }),
          messages: [],
        };
        threads.set(rootTs, thread);
        thread.messages.push(messageFromRow(message, names));
      }
      return { ...empty, threads: [...threads.values()], more: unread.length - page.length };
    });
    return { result: activity, text: presentActivity(activity, at) };
  };
}

export function markReadCommand({
  database,
}: Pick<ActivityCommandOptions, "database">): CommandHandler<"mark-read"> {
  return async ({ through }, { channelId }) => {
    const marked = await database.write(async (transaction) => {
      const link = await readCallerLink(transaction, channelId);
      const [cursor] = await transaction<{ through: number }[]>`
        UPDATE cursors SET through_seq = max(through_seq, ${through})
        WHERE link_id = ${link.id} AND served_through_seq >= ${through}
        RETURNING through_seq AS through
      `;
      if (!cursor) {
        throw new CommandRefusedError(
          `Activity hasn't shown you change ${through}, so it isn't marked read. Run \`toy-box-slack activity\`, then the mark-read it ends with.`,
        );
      }
      return { channel: link.channel, through: cursor.through };
    });
    return { result: marked, text: `${marked.channel} is read through change ${marked.through}.` };
  };
}
