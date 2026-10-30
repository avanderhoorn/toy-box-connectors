# Outbox

The outbox owns threaded replies, periodic publications and the posts the owner asks for in the
watched Slack channel. Each item has an opaque metadata ID, a never-reused number, an immutable
attempted payload and its hash, and a delivery state. A reply's request and a publication's
`(link, series, scheduled slot)` are unique, so each reserves its purpose. Unknown delivery and
retraction never release that reservation. A duplicate command refuses with the first item's
number and state, rather than queueing again. A post reserves nothing, so it refuses as a repeat
of any item saying the same in the same place while that item may still go out or its delivery
is unknown, and for 10 minutes after it's sent. An item that may still go out keeps its payload.
Any other forgets it 30 days after it last changed and keeps its hash, so delivery can still be
proven and the reservation still holds. A post's whole row goes then instead, unless its delivery
is unknown or an item is still in its thread, which the bridge names by the post's number. A
reply's item goes with its request, whose number is never handed out again, and so does a post in
that request's thread. A finished request stays while such a post may still go out or its delivery
is unknown, so the post can still be proven.

A post goes at the top of its link's channel, or in a thread there that it names by a request in
it, such as r14, or by the link's own top-level item it's under, such as o31. `server/threads.ts`
decides whether a thread takes a post. A request's thread does while the request isn't
cancelled, its requester is still allowed and no request there waits on its reply, so a post
never stands in for an answer. A top-level item's thread does while that item is in Slack.
Activity names each thread a post can go in by that same check, so it never offers a thread
`post` would refuse. A post can mention people its link allows, by member ID, and is refused
naming anyone else.

## Posting once

Before posting, read fresh channel facts and recheck the installation, link, destination,
the thread's request and its requester's current permission, that the top-level item a post
is under is still in Slack, and that the link still allows everyone a post mentions, so a reply
or post whose request was cancelled, or a post mentioning someone denied since, fails instead
of posting. Commit `sending`, the attempt number and its start time before calling Slack. SDK
retries are disabled. Share the client's method cooldowns and defer a 429 until its Retry-After
deadline. Restarting may encounter another 429, never retry an ambiguous post.

A matching response confirms delivery. A lost, malformed or ambiguous response becomes
`delivery_unknown`. Startup treats interrupted sends the same way. Read the intended thread
or publication history around one and five minutes after the attempt. Only our bot's exact
item ID, payload hash and destination prove delivery. Complete misses leave the item unknown.
Partial or failed reads spend no check. There is no automatic resend or manual resolution.
An unknown item can settle only on positive delivery proof, never a later apparent refusal.

The bridge recovers interrupted attempts before starting work. The worker shares its one bot
client, waits for verified Slack readiness, and serializes coalesced command pokes and a
one-second fallback timer. Stop drains the current pass before storage closes. The wake
scheduler hands it the requests no lead had read once Toy Box runs their wake, and inbox the
requests it just served after commit. Their best-effort eyes batch has no stored state, and
moves on when Slack refuses one, such as a second 👀 on a message.

Queueing a reply calls the request model's `beginAnswer` in the same transaction. Proven
delivery calls `confirmAnswer`. Only a definite refusal can return it to seen and replace
the payload on that same failed row. A post in the request's thread never begins, confirms or
returns its answer. When link or resume approves a wider audience, every item the link holds
queued fails that way, while one sending or unknown stays. When they end a pause or suspension
without one, only the link's queued posts fail, since the owner may have paused to stop them.
Late results settle only their matching attempt.
Retraction deletes one confirmed post and keeps the original reservation. Unlink deletes
the link's local state rather than leaving an orphan-cleanup subsystem.

## Text

Send one Slack `markdown` block with a mention-neutralized fallback, disabled automatic
parsing and disabled unfurls. The block repeats the fallback, and a post's opens with a line of
the people it mentions, once each, which the fallback leaves out, since the block alone notifies
them. Escape `<` only before `@` or `!`, break plain broadcast words with a zero-width space,
and leave other Markdown unchanged, including code. Refuse blank output or a block over 12,000
characters rather than split or truncate it.
`outputProblem` refuses recognizable credentials
by category without repeating them. It is a guardrail, not complete DLP.

The send boundary accepts only canonical renderer output, rendering the fallback again with
the people its block's opening line mentions, and rechecks secrets without changing the stored
bytes. Slack translates Markdown into its own block layout, so delivery proof must
not compare returned blocks with the outbound snapshot.
