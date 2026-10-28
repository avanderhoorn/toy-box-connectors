# Links

Links hold the owner's settings for each Toy Box channel's Slack connection: which Slack channel it watches, where publications go, who may make requests, how much the bridge keeps, and which routines the lead registered. Every change is validated, confirmed, and audited here.

## Domain model

A link binds one Toy Box channel to one Slack channel. Its allowlist names Slack people by exact user ID, each as `owner` or `allowed`. Request mode is `mention` by default or `all`, and observe mode is `requesters` by default or `channel`. A link waits for its requests routine before it becomes active. The owner can pause it, and the bridge suspends it when Slack or Toy Box makes continuing unsafe.

## Approvals

A change that widens access is a proposal. `server/setup.ts` reads fresh facts from Slack and Toy Box, checks the change against the link and the limits on open and recent proposals, and stores it as an approval with its read-set, the facts its card shows, numbered after every approval there has ever been. A click is decided in the receiver's transaction before Slack is acked, from stored facts only: the card's own message, the pinned owner, the approval's state and its hour. An approved change applies after the ack in `server/apply.ts`, which reads the facts again and applies only when everything the card showed still holds and the change is still valid, such as the owner and the bot still being in the channel. Otherwise the approval goes stale and its card says why. A crash after the decision leaves it approved, and the applier applies it at start. A read that proves nothing is tried again with backoff, honoring Slack's Retry-After, and the applier waits while the installation can't use Slack. Fifteen minutes after the click without a complete read, the approval goes stale as not verified. An owner handoff voids every open card, since each asked the old owner.

## Boundaries and invariants

- Every change writes an audit entry in the same transaction, with IDs only and never message text.
- A change that widens access needs the owner's confirmation. `pause`, `deny`, `unlink` and a narrowing `set` apply at once and void the open cards they would reverse.
- The owner confirms only by clicking Approve on the bridge's own card. `model/cards.ts` renders it from the approval each time the outbox posts or updates it. It mentions only the owner, shows channels as Slack's own references and people by stored name with their ID, and carries buttons only while pending. Nothing a person or the lead chose can mention, link or format on it.
- A proposal allows at most 20 people, so its card shows every name it asks the owner to approve.
- Members can read settings but never change them, and the operator can never reply or publish.
- Unlinking purges everything the link owned.
- Uninstalling purges every row but the installation and records the purge. Resetting purges the installation and its owner too, but keeps the audit log, so what led to a reset can still be read. `server/purge.ts` gives each table its fate in a map a test holds to the schema, so a new table has to choose one.
- No purge touches SQLite's own tables, so outbox items, approvals and gaps go on numbering after every one there has been, and a number the lead or a card still holds never names another.
