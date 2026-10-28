# Activity

Activity is the bridge's durable record of what happens in each linked Slack channel. It turns Socket Mode events into one ledger of messages and suspends a link when Slack says its channel can't be used as the owner approved it. The Slack API feature in `src/features/slackapi` feeds it, and requests and the CLI read from it.

## From event to ledger

Each Socket Mode frame is read into a delivery before anything else sees it, so top-level control payloads such as `app_rate_limited` and `disconnect` are handled before the SDK could throw on them, and a payload without a channel is never dropped for that reason alone. The receiver takes deliveries one at a time in the order they arrived. Each commits everything it changes in one transaction, and its envelope is acked only after that commit, and only while Slack still waits: 2.5 seconds after it arrived. A delivery stored too late isn't acked, and its redelivery changes nothing, because the ledger merges each version of a message once and a link is suspended once. A delivery that fails to commit isn't acked, and the receiver stops without handling anything after it. A rate-limited minute and a delivery that can't be read are only logged, the latter by its issue codes and paths.

An event counts only when it's for our app and our bot, and nothing is taken before the bridge knows its installation or once the app is uninstalled. A message goes through ingest, which stores nothing from a channel no link watches, and stores its author under the ID the bridge knows them by, even when Slack names them by an alias. A notice in the channel, and each lifecycle event, can suspend the channel's link: our bot leaving, an archive, a deletion, the channel being shared with another workspace, or a channel the owner approved while it was private being made public. A move to a new ID suspends the link on the old ID until the owner links the channel again. An uninstall, or our bot's token being revoked, deletes everything but the installation.

The ledger keeps one row per channel and `ts`. Every new, edited, or deleted message appends a change with an increasing sequence, so readers follow changes instead of rescanning messages. A merge that changes nothing appends nothing, so replaying an envelope converges to the same rows. A `ts` is an exact decimal string. It is never parsed into a float, and comparisons use the decimal order of its seconds and fraction.

A delete leaves a tombstone that no version of the message can undo, even one that arrives first, and its text is forgotten. When someone deletes a root that still has replies, Slack leaves a tombstone message in its place and sends the root's `message_deleted` only after the last reply's, so that tombstone counts as the delete, and the replies stay. Slack withdraws a message when an admin's key no longer unlocks it or a rule hides it, and the ledger stores that as its delete, since the bridge may no longer keep what it said. Only the message's own `hidden` flag counts, since Slack hides every edit and delete event too.

Each message gets its author role when it's stored. In the default requesters mode, text is kept only from allowlisted people, from the bot, and from anyone posting in a thread where a request started. Every other message becomes a content-free marker, so the digest cursor still accounts for it. Another bot's text is never kept. A marker whose text is kept when the same version arrives again is filled in without counting as an edit.

## Boundaries and invariants

- Commit before ack. A delivery is acked only after what it changed commits, and only while Slack still waits for the ack.
- Logs hold no message content.
- Every version of a message merges through one idempotent function, so a redelivery converges to the same rows.
- Nothing from an unlinked channel is stored.
- SDK retries are off. Every Web API call goes through the shared bot client in `src/features/slackapi`, which makes one attempt per call, holds a rate-limited method back for every caller, and leaves what happens next to its caller.
