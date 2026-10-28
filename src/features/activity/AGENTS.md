# Activity

Activity is the bridge's durable record of what happens in each linked Slack channel. It turns Socket Mode events and recovered history into one ledger of messages, follows the threads the bridge must track, records which spans of time it may have missed, and repairs them. The Slack API feature in `src/features/slackapi` feeds it, and requests, digests, and the CLI read from it.

## From event to ledger

The receiver holds the Socket Mode connection and parses each raw envelope before the SDK dispatches it. It commits the event and everything the event changes in one transaction and acks only after that commit. An event receipt makes redelivery idempotent: Slack resends an envelope it didn't see acked, and an existing receipt means the work is already done. Top-level control payloads such as `app_rate_limited` and `disconnect` are handled before the SDK sees them, and a payload without a channel is never dropped for that reason alone.

The ledger keeps one row per channel and `ts`. Every new, edited, or deleted message appends a change with an increasing sequence, so readers follow changes instead of rescanning messages. A merge that changes nothing appends nothing, so replaying an envelope or a history page converges to the same rows. A `ts` is an exact decimal string. It is never parsed into a float, and comparisons use the decimal order of its seconds and fraction.

Each message gets its author role when it's stored. In the default requesters mode, text is kept only from allowlisted people, from the bot, and from anyone posting in a request thread. Every other message becomes a content-free marker, so the digest cursor and repair still account for it. Another bot's text is never kept.

## Gaps and repair

Coverage records the spans of time the bridge may have missed. A gap opens when the connection drops, when Slack rate-limits event delivery, and at startup from the last receipt. Repair reads channel history across the gap with overlap, re-reads every tracked thread, and merges what it finds through the same function as live events. A tracked thread is one the bridge must follow, usually because a request lives in it. When a request starts inside an existing thread, the ledger hydrates the whole thread first.

## Boundaries and invariants

- Commit before ack. An event is acked only after its receipt and its effects commit.
- Live events and repair merge through one idempotent function.
- A gap is marked repaired only after a complete scan. A partial scan stays partial.
- A message missing from a history page is never treated as deleted.
- Nothing from an unlinked channel is stored.
- SDK retries are off. Every Web API call goes through the shared bot client in `src/features/slackapi`, which makes one attempt per call, holds a rate-limited method back for every caller, and leaves what happens next to its caller.
