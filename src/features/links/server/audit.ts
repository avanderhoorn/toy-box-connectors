// The audit log.
//
// Every change to who can make the lead act, or who can change that, writes an entry in the
// transaction that makes it, and so does every click the bridge ignores and every try at a claim
// code. An entry holds IDs and reason codes only, never message text.

/** Who made a change: a lead or member session, the person at a terminal, the owner's click, or the bridge itself. */
export type AuditActor = "lead" | "member" | "operator" | "owner" | "bridge";

export type AuditEntry = {
  actor: AuditActor;
  action: string;
  linkId?: string | null;
  approvalId?: string | null;
  /** The Slack user or channel the change is about, or the reason for it. */
  subject?: string | null;
};

/** Writes an audit entry for a change in the same transaction. */
export async function audit(transaction: Bun.SQL, entry: AuditEntry, now: number): Promise<void> {
  await transaction`
    INSERT INTO audit (at, actor, action, link_id, approval_id, subject)
    VALUES (${now}, ${entry.actor}, ${entry.action}, ${entry.linkId ?? null},
      ${entry.approvalId ?? null}, ${entry.subject ?? null})
  `;
}
