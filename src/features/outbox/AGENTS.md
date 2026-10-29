# Outbox

The outbox owns threaded replies and periodic publications in the watched Slack channel.
Each item has an opaque metadata ID, a never-reused number, an immutable attempted payload
and its hash, and a delivery state. A unique request ID or `(link, series, scheduled slot)`
reserves its purpose. Unknown delivery and retraction never release that reservation.
A duplicate command refuses with the first item's number and state, rather than queueing again.
An item that may still go out keeps its payload. Any other forgets it 30 days after it last
changed and keeps its hash, so delivery can still be proven and the reservation still holds.
A reply's item goes with its request, whose number is never handed out again.

## Posting once

Before posting, read fresh channel facts and recheck the installation, link, destination,
request and requester's current permission, so a reply whose request was cancelled fails
instead of posting. Commit `sending`, the attempt number and its start time before
calling Slack. SDK retries are disabled. Share the client's method cooldowns and defer a 429
until its Retry-After deadline. Restarting may encounter another 429, never retry an ambiguous post.

A matching response confirms delivery. A lost, malformed or ambiguous response becomes
`delivery_unknown`. Startup treats interrupted sends the same way. Read the intended thread
or publication history around one and five minutes after the attempt. Only our bot's exact
item ID, payload hash and destination prove delivery. Complete misses leave the item unknown.
Partial or failed reads spend no check. There is no automatic resend or manual resolution.
An unknown item can settle only on positive delivery proof, never a later apparent refusal.

The bridge recovers interrupted attempts before starting work. The worker shares its one bot
client, waits for verified Slack readiness, and serializes coalesced command pokes and a
one-second fallback timer. Stop drains the current pass before storage closes. Inbox hands it
the requests just served after commit, and their best-effort eyes batch has no stored state.

Queueing a reply calls the request model's `beginAnswer` in the same transaction. Proven
delivery calls `confirmAnswer`. Only a definite refusal can return it to seen and replace
the payload on that same failed row. Late results settle only their matching attempt.
Retraction deletes one confirmed post and keeps the original reservation. Unlink deletes
the link's local state rather than leaving an orphan-cleanup subsystem.

## Text

Send one Slack `markdown` block with an identical mention-neutralized fallback, disabled
automatic parsing and disabled unfurls. Escape `<` only before `@` or `!`, break plain broadcast
words with a zero-width space, and leave other Markdown unchanged, including code.
Refuse blank output or more than 12,000 escaped characters rather than split or truncate it.
`outputProblem` refuses recognizable credentials
by category without repeating them. It is a guardrail, not complete DLP.

The send boundary accepts only canonical renderer output and rechecks secrets without changing
the stored bytes. Slack translates Markdown into its own block layout, so delivery proof must
not compare returned blocks with the outbound snapshot.
