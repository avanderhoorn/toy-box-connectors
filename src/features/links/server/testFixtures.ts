import { createStoredMessage } from "@activity/server/testFixtures";
import type { BridgeDatabase } from "@bridge/server/database";
import type { Audience } from "@links/model/audience";
import { privateAudience } from "@links/model/testFixtures";
import { createStoredOutboxItem } from "@outbox/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { askMessage, channelFacts } from "@slackapi/model/testFixtures";
import { writeChannelInfo } from "@slackapi/server/channels";
import { createStoredInstallation } from "@slackapi/server/testFixtures";

/**
 * Persist an active Link fixture so rows that belong to a Link can be stored. It watches C-{id},
 * which the owner approved as a private channel of T-home. `columns` replace the fixture's, such as
 * its settings or a Toy Box channel a fake serves.
 */
export function createStoredLink(
  database: BridgeDatabase,
  id = "link",
  columns: {
    toybox_channel_id?: string;
    slack_channel_id?: string;
    status?: "active" | "paused" | "suspended";
    status_reason?: string | null;
    request_mode?: "mention" | "all";
    observe?: "requesters" | "channel";
    approved_audience?: Audience;
  } = {},
) {
  const { approved_audience: approved, ...rest } = columns;
  const link = {
    id,
    toybox_channel_id: `toybox-${id}`,
    slack_channel_id: `C-${id}`,
    status: "active",
    approved_audience: JSON.stringify(approved ?? privateAudience()),
    linked_at_ts: "1700000000.000100",
    created_at: 0,
    updated_at: 0,
    ...rest,
  };
  return database.write((transaction) => transaction`INSERT INTO links ${transaction(link)}`);
}

/** Stores a row in every table, so deleting everything can be checked against the whole schema. */
export async function fillEveryTable(database: BridgeDatabase): Promise<void> {
  await createStoredInstallation(database);
  await createStoredLink(database);
  await createStoredMessage(database, askMessage());
  await createStoredRequest(database);
  await createStoredOutboxItem(database, 1);
  await database.write(async (transaction) => {
    await writeChannelInfo(transaction, channelFacts(), 1_000);
    await transaction`
      INSERT INTO receipts (key, type, received_at, disposition)
      VALUES ('Ev-1', 'events_api', 0, 'applied')
    `;
    await transaction`INSERT INTO rate_limits (method, next_attempt_at) VALUES ('chat.postMessage', 0)`;
    await transaction`INSERT INTO outbox_channels (channel_id, next_post_at) VALUES ('C-link', 1000)`;
    await transaction`INSERT INTO channel_aliases VALUES ('C-old', 'C-link', 0)`;
    await transaction`INSERT INTO users (user_id) VALUES ('U-carol')`;
    await transaction`INSERT INTO user_aliases VALUES ('W-carol', 'U-carol')`;
    await transaction`INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-carol', 0)`;
    await transaction`
      INSERT INTO threads (channel_id, thread_ts, tracked_reason)
      VALUES ('C-link', '1700000100.000100', 'request')
    `;
    await transaction`
      INSERT INTO coverage (link_id, channel_id, scope, oldest_ts, latest_ts, state, reason, opened_at)
      VALUES ('link', 'C-link', 'channel', '1700000000.000100', '1700000100.000100', 'open',
        'startup', 0)
    `;
    await transaction`INSERT INTO cursors (link_id) VALUES ('link')`;
    await transaction`
      INSERT INTO files (file_id, channel_id, ts, state, local_path, fetched_at) VALUES
        ('F-kept', 'C-link', '1700000100.000100', 'fetched', 'F-kept/report.pdf', 0),
        ('F-indexed', 'C-link', '1700000100.000100', 'indexed', NULL, NULL)
    `;
    await transaction`INSERT INTO wakes (link_id, at, outcome) VALUES ('link', 0, 'ran')`;
    await transaction`
      INSERT INTO request_messages (request_id, channel_id, ts)
      VALUES (1, 'C-link', '1700000100.000200')
    `;
  });
}

/** How many rows each table holds, by name. */
export async function countRows(database: BridgeDatabase): Promise<Record<string, number>> {
  return database.read(async (sql) => {
    const tables = await sql<{ name: string }[]>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `;
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const [row] = await sql.unsafe<{ count: number }[]>(`SELECT count(*) AS count FROM ${name}`);
      counts[name] = row!.count;
    }
    return counts;
  });
}
