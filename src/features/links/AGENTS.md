# Links

Links hold the owner's settings for each Toy Box channel's Slack connection: which Slack channel it watches, where publications go, who may make requests, how much the bridge keeps, and which routines the lead registered. Every change is validated, confirmed, and audited here.

## Domain model

A link binds one Toy Box channel to one Slack channel. Its allowlist names Slack people by exact user ID, each as `owner` or `allowed`. Request mode is `mention` by default or `all`, and observe mode is `requesters` by default or `channel`. A link waits for its requests routine before it becomes active. The owner can pause it, and the bridge suspends it when Slack or Toy Box makes continuing unsafe.

## Boundaries and invariants

- Every change writes an audit entry in the same transaction, with IDs only and never message text.
- A change that widens access needs the owner's confirmation. `pause` and `deny` only narrow access and skip it.
- The owner confirms only by clicking Approve on the bridge's own card. `model/cards.ts` renders it from the approval each time the outbox posts or updates it. It mentions only the owner, shows channels as Slack's own references and people by stored name with their ID, and carries buttons only while pending. Nothing a person or the lead chose can mention, link or format on it.
- A proposal allows at most 20 people, so its card shows every name it asks the owner to approve.
- Members can read settings but never change them, and the operator can never reply or publish.
- Unlinking purges everything the link owned.
