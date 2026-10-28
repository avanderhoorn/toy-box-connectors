// Receipts.
//
// A receipt commits with whatever its delivery changed, before the ack, so a redelivery that finds
// one is acked and changes nothing. It holds no content.

/** What became of a delivery. */
export type ReceiptDisposition =
  /** It changed the ledger, a link or a file. */
  | "applied"
  /** It read as a claim, which was consumed. */
  | "claim"
  /** No link watches its channel. */
  | "unlinked"
  /** Nothing the bridge handles, or nothing it may take while Slack rejects the bot token. */
  | "ignored"
  /** Slack delivered it for another app, workspace or installation. */
  | "foreign"
  /** It couldn't be read, so repair reads what it was about. */
  | "malformed"
  /** Slack held events back for a minute, so repair reads that minute. */
  | "rate_limited"
  /** A click, which approvals decided. */
  | "interactive";

export type Receipt = {
  key: string;
  /** The event or frame type, such as message or interactive. */
  type: string;
  /** When the delivery arrived, the last moment the bridge knows it was receiving. */
  receivedAt: number;
  disposition: ReceiptDisposition;
};

/** Whether a delivery with `key` has been received already. */
export async function hasReceipt(sql: Bun.SQL, key: string): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM receipts WHERE key = ${key}`;
  return row !== undefined;
}

/** Records that a delivery was received, in the transaction that applied it. */
export async function recordReceipt(transaction: Bun.SQL, receipt: Receipt): Promise<void> {
  const row = {
    key: receipt.key,
    type: receipt.type,
    received_at: receipt.receivedAt,
    disposition: receipt.disposition,
  };
  await transaction`INSERT INTO receipts ${transaction(row)}`;
}

/** When the latest delivery the bridge holds a receipt for arrived, or null when it holds none. */
export async function readLastReceiptAt(sql: Bun.SQL): Promise<number | null> {
  const [row] = await sql<{ received_at: number | null }[]>`
    SELECT max(received_at) AS received_at FROM receipts
  `;
  return row?.received_at ?? null;
}
