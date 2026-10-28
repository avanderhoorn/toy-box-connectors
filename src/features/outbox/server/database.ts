// Stored outbox items.

/**
 * Cancels a request's replies and progress notes that are still queued. One already sending may
 * still land, so it's left to finish.
 */
export async function cancelQueuedRequestItems(
  transaction: Bun.SQL,
  requestId: number,
  now: number,
): Promise<void> {
  await transaction`
    UPDATE outbox SET state = 'cancelled', updated_at = ${now}
    WHERE request_id = ${requestId} AND state = 'queued' AND kind IN ('reply', 'progress')
  `;
}
