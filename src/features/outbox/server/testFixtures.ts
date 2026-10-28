import type { BridgeDatabase } from "@bridge/server/database";

/**
 * Persist a queued final reply to revision 1 of request 1 as outbox item `number`. `columns`
 * replace the fixture's, such as its request, kind, phase and state.
 */
export function createStoredOutboxItem(
  database: BridgeDatabase,
  number: number,
  columns: Record<string, string | number | null> = {},
) {
  const item = {
    id: `item-${number}`,
    number,
    link_id: "link",
    request_id: 1,
    request_rev: 1,
    kind: "reply",
    phase: "final",
    channel_id: "C-link",
    thread_ts: "1700000100.000100",
    payload: "{}",
    payload_hash: "hash",
    state: "queued",
    created_at: 0,
    updated_at: 0,
    ...columns,
  };
  return database.write((transaction) => transaction`INSERT INTO outbox ${transaction(item)}`);
}
