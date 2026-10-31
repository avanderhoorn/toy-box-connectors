import { createStoredMessage } from "@activity/server/testFixtures";
import type { BridgeDatabase } from "@bridge/server/database";
import type { Audience } from "@links/model/audience";
import { privateAudience } from "@links/model/testFixtures";
import { createStoredOutboxItem } from "@outbox/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { askMessage, sharedFile } from "@slackapi/model/testFixtures";
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
    slack_channel_name?: string | null;
    status?: "active" | "paused" | "suspended";
    status_reason?: string | null;
    request_mode?: "mention" | "all";
    observe?: "requesters" | "channel";
    approved_audience?: Audience;
    linked_at_ts?: string;
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
  await createStoredMessage(
    database,
    askMessage("1700000100.000100", { files: [sharedFile("F1")] }),
  );
  await createStoredRequest(database);
  await createStoredOutboxItem(database, 1);
  await database.write(async (transaction) => {
    await transaction`INSERT INTO users (user_id) VALUES ('U-carol')`;
    await transaction`INSERT INTO user_aliases VALUES ('W-carol', 'U-carol')`;
    await transaction`INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-carol', 0)`;
    await transaction`INSERT INTO cursors (link_id) VALUES ('link')`;
    await transaction`INSERT INTO wakes (link_id, at, outcome) VALUES ('link', 0, 'ran')`;
    await transaction`INSERT INTO gaps (starts_at, ends_at) VALUES (0, 0)`;
    await transaction`INSERT INTO outbox_files (item_id, position, file_id) VALUES ('item-1', 0, 'F-shown')`;
    await transaction`INSERT INTO file_deletions (file_id, due_at, created_at) VALUES ('F-owed', 0, 0)`;
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
