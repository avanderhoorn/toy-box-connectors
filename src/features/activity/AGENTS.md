# Activity

Activity is the bridge's durable record of what happens in each linked Slack channel. It turns Socket Mode events and recovered history into one ledger of messages, follows the threads the bridge must track, records which spans of time it may have missed, and repairs them. The Slack API feature in `src/features/slackapi` feeds it, and requests, digests, and the CLI read from it.

## From event to ledger

Each Socket Mode frame is read into a delivery before anything else sees it, so top-level control payloads such as `app_rate_limited` and `disconnect` are handled before the SDK could throw on them, and a payload without a channel is never dropped for that reason alone. The receiver takes deliveries one at a time in the order they arrived. Each commits everything it changes with its receipt in one transaction, and its envelope is acked only after that commit, and only while Slack still waits: 2.5 seconds after it arrived. A receipt is keyed by what every redelivery repeats, the event ID, a rate-limited minute or else the envelope ID, so a delivery stored too late isn't acked, and its redelivery finds the receipt and changes nothing. A delivery that fails to commit isn't acked, and the receiver stops without handling anything after it.

An event counts only when it's for our app and our bot, and anything else is acked with a foreign receipt. A message goes through ingest, which consumes a claim before anything else, stores nothing from a channel no link watches, and stores a channel under the ID it has now, even when a late event names one Slack moved it from. A notice about the channel, and each lifecycle event, acts on the links that use the channel. Our bot leaving, an archive or a deletion suspends them, a channel made public suspends the links the owner approved while it was private, and any other change casts doubt on what's stored about the channel until a fresh read. A move to a new ID takes the links, the ledger and the requests along, and suspends the links until the owner approves the channel as it is now. An uninstall, or our bot's token being revoked, purges everything. Local copies of files whose rows a delivery deleted are removed after its commit.

While Slack rejects the bot token, a channel's lifecycle, deletes, withdrawals, gaps and clicks are still taken, because repair can't find any of them later. What's posted or edited meanwhile is left for the repair that follows recovery.

The ledger keeps one row per channel and `ts`. Every new, edited, deleted, or withdrawn message appends a change with an increasing sequence, so readers follow changes instead of rescanning messages. A merge that changes nothing appends nothing, so replaying an envelope or a history page converges to the same rows. A `ts` is an exact decimal string. It is never parsed into a float, and comparisons use the decimal order of its seconds and fraction.

A delete or a withdrawal leaves a tombstone that no version of the message can undo, even one that arrives first, and its text and files are forgotten. When someone deletes a root that still has replies, Slack leaves a tombstone message in its place and sends the root's `message_deleted` only after the last reply's, so that tombstone counts as the delete, live or repaired, and the replies stay. Slack withdraws a message when an admin's key no longer unlocks it or a rule hides it. Only the message's own `hidden` flag counts, since Slack hides every edit and delete event too. A later delete turns a withdrawn message into a deleted one, and views show a withdrawn message as "access withdrawn". A withdrawn source holds its request's replies until repair re-reads it, and the request is revised without it.

Each message gets its author role when it's stored. In the default requesters mode, text is kept only from allowlisted people, from the bot, and from anyone posting in a request thread. Every other message becomes a content-free marker, so the digest cursor and repair still account for it. Another bot's text is never kept.

## Gaps and repair

Coverage records the spans of time the bridge may have missed. A gap opens when the connection drops, when Slack rate-limits event delivery, when a delivery can't be read, when Slack moves a channel to a new ID, and at startup from the last receipt. A delivery that can't be read is logged by its issue codes and paths only, and its gap runs from when it happened, in the channel it names or in every linked channel when it names none. Repair reads channel history across the gap with overlap, re-reads every tracked thread, and merges what it finds through the same function as live events. A tracked thread is one the bridge must follow, usually because a request lives in it. When a request starts inside an existing thread, the ledger hydrates the whole thread first.

## Boundaries and invariants

- Commit before ack. A delivery is acked only after its receipt and its effects commit, and only while Slack still waits for the ack.
- Receipts and logs hold no message content.
- A claim is consumed before anything else and never stored.
- Live events and repair merge through one idempotent function.
- A gap is marked repaired only after a complete scan. A partial scan stays partial.
- A gap's ID is never reused, so a repair that outlives its gap can't close a newer one.
- A message missing from a history page is never treated as deleted.
- Nothing from an unlinked channel is stored.
- SDK retries are off. Every Web API call goes through the shared bot client in `src/features/slackapi`, which makes one attempt per call, holds a rate-limited method back for every caller, and leaves what happens next to its caller.
