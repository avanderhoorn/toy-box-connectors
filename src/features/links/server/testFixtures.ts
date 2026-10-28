import type { BridgeDatabase } from "@bridge/server/database";

/**
 * Persist an active Link fixture so rows that belong to a Link can be stored. `columns` replace
 * the fixture's, such as its settings or a Toy Box channel and routine a fake serves.
 */
export function createStoredLink(
  database: BridgeDatabase,
  id = "link",
  columns: {
    toybox_channel_id?: string;
    requests_routine_id?: string;
    status?: "active" | "paused" | "suspended";
    request_mode?: "mention" | "all";
    observe?: "requesters" | "channel";
  } = {},
) {
  const link = {
    id,
    toybox_channel_id: `toybox-${id}`,
    slack_channel_id: `C-${id}`,
    publish_channel_id: `C-${id}`,
    status: "active",
    requests_routine_id: `routine-${id}`,
    routine_state: "present",
    linked_at_ts: "1700000000.000100",
    created_at: 0,
    updated_at: 0,
    ...columns,
  };
  return database.write((transaction) => transaction`INSERT INTO links ${transaction(link)}`);
}
