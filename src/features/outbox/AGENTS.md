# Outbox

The outbox is the only way the bridge writes to Slack. Replies, progress notes, publications, retractions, reactions, and thread status are queued as outbox items, checked again at send time, posted once with metadata that names the item, and reconciled whenever the bridge can't tell whether Slack accepted them.

## Domain model

An outbox item has an opaque ID carried in the posted message's metadata, a number shown to the lead as `o31`, a kind, a target channel and thread, a payload and its hash, and a state. No item ever takes a number another has had, even one a purge deleted. A publication key makes each periodic publication unique per link, so a routine that runs twice posts once. A repeated reply returns the existing item instead of queuing another.

## Delivery

An item becomes `sending` in a committed transaction before the call is made, so a crash mid-call leaves evidence. A confirmed response makes it `sent`. A timeout, a dropped connection, or an ambiguous error makes it `delivery_unknown`, and reconciliation looks for the item's metadata in the target conversation before anything is sent again. At startup, every item still `sending` becomes `delivery_unknown`. The lead settles what reconciliation can't with `resolve --resend` or `resolve --drop`.

A rate limit pauses only the method Slack limited, until the time Slack named.
The shared bot client owns those cooldowns and installation-wide authentication failures,
including expired tokens. `model/delivery.ts` classifies its outcomes and owns the proof a
post needs: the intended channel and thread, our bot and app, and the item's metadata and
payload hash. Manual resolution may use exact sent text only when metadata is absent,
never when metadata identifies another item. A receipt that shows a reply at the root
requires withdrawal, not confirmation.

`server/posts.ts` posts finals, follow-ups, publications and new approval cards, and updates cards
through the shared bot client, never from inside a write. It refreshes missing or stale channel facts before checking
all authority again, commits sending, then builds metadata from the committed snapshot. Receipt
proof and request settlement share a transaction. A misplaced receipt stores stray and queues its
withdrawal together. Cards bypass a link's audience gate so a suspended link can receive its resume
card, but still require an active installation and the approval's current target.
An update snapshots only its actual arguments, including the proved card ts, and keeps parse none
without post-only flags or actions blocks. It follows a decision, never a pending card, so a timed-out older update
can show an older outcome but cannot restore buttons. An edit receipt must match its known target;
Slack need not repeat ts inside message. Withdrawn snapshots never prove a receipt or a read,
even when they retain our identity and metadata.

`server/reconcile.ts` reads unknown messages through single-page history helpers and the shared
client. It scans the whole intended thread, then roots since the attempt for a misplaced reply,
or roots since the attempt for a publication or initial card. Those root bounds subtract the
shared five-minute gap overlap to absorb ordinary skew between the Mac and Slack's clock.
An edit reads its already proved target, even when that message predates the attempt.
Only exact own-bot/app metadata proves it.
Positive proof can finish immediately. A complete miss advances one of the three original
deadlines, never requeues a post, and exhaustion leaves the item unknown.
thread_not_found completes its thread scope, but a post still finishes its root correlation scan.
Partial cursors survive cooldowns in memory so a thread longer than one rate-limit window can
finish. They are discarded on restart or invalidation without spending a pass. Concurrent calls
for one item coalesce, and close drains its read and prevents another page. Missing or cyclic
cursors, malformed pages and failed reads report an explicit hold rather than a complete pass.
These failures back off from 5 to 120 seconds per attempt and pass without resetting at a cursor
restart. Slack's Retry-After wins even when longer. The scheduled deadline survives a restart,
while the in-memory failure streak starts again. A channel refusal suspends its links and clears
the read deadline. The due reader selects it again only once its link is active, and reconciliation
releases that hold conditionally before reading. A refused linkless card needs manual resolution.
`slackapi/model/history.ts` keeps raw messages intact for their owning decoder and distinguishes
an empty page from an exhausted cursor.
After unlink, redacted sending or unknown posts still settle against their original hash.
An edit retains its frozen ts beside the redaction marker. Valid late deliveries are purged,
not withdrawn. A misplaced one still gets withdrawn first. Channel-refused and exhausted
orphans are purged, including a hold or final pass that predates unlink. The due reader keeps
these stopped orphans eligible for local disposal without another Slack call.

`server/delivery.ts` commits both response and read proof through the same settlement path:
the initial card ts, misplaced cleanup and request settlement cannot be lost between them.
A thread refusal (thread_not_found, restricted_action_thread_locked, cannot_reply_to_message
or restricted_action_non_threadable_channel), or a reply proved outside its thread, cancels
its active request as thread_gone immediately and queues removal of its eyes reaction.
It never waits for withdrawal, which may fail. Thread-only and non-threadable channel
restrictions remain item-local, since they do not prevent every kind of post.
A card update with no proved ts waits only while an initial post is queued, sending or unknown.
Without such a post it is dropped explicitly. The queue runner must revisit these waits when a
post settles, including a manual resolution.

`server/retract.ts` deletes only the proved message of a reply, progress note or publication,
or a misplaced initial card. Its operation must match the target's link, channel, request and
thread. Cleanup bypasses a suspended link's posting gate but never an inactive installation.
`queueRetraction` shares an outstanding operation for the same target and scope. The snapshot
retains that local target ID alongside the frozen Slack ts; only channel and ts go on the wire.
An uncertain deletion retries that same target with 5-to-120-second backoff, and message_not_found
means it is already absent. Startup-recovered deletions go to this handler, not message reads.
A valid delivery becomes retracted without losing its proof or publication key. A withdrawn
misplaced post becomes failed, never retracted. Its request was already cancelled as thread_gone.
The operation, target and request commit together. Failed withdrawal leaves the target stray
with Slack's exact error, and an explicit new retraction can try again.
A retained unlink target needs no message body. Once confirmed absent, a target whose non-null
link ID no longer exists is purged with its operation. Failed orphan cleanup keeps its redacted
stray for the operator. Cleanup settles a final's request only if its link, channel and thread
still match, and a local cleanup refusal never settles a reply merely by its numeric request ID.
An unlinked card's initial delivery remains until its stale update settles, then its approval
and card rows are purged. A card that never started is dropped without posting a new stale card.
Stray card targets survive that purge, redacted, until withdrawal finishes.

`model/posting.ts` checks the current installation, link, destination, requester and request
revision. Only explicit follow-ups reach answered, dismissed or expired requests, and none
reach cancelled requests. A destination needs channel facts younger than two minutes with no
invalidation. Both roles are judged when a channel is monitored and published to, against the
owner-approved audiences. This pure gate asks for a refresh or hold rather than guessing.

`server/answers.ts` settles one request inside the transaction that proves a delivery or
changes its source. Proof alone cannot answer a request while its source is unverified.
Intake calls the same function after every revision, and repair after verification, revision or
cancellation, so either order settles the same way without polling. A current confirmed final answers only verified input,
an older final returns the request as updated, and other failed or dropped finals return it as
reply failed unless a replacement still waits. The answered transition queues both reactions
in that transaction. Retraction preserves a valid delivery's proof, while withdrawing a
misplaced post is failure, never a successful delivery.

`server/database.ts` commits each attempt's method, start time, incremented attempt count, and
exact send-time payload before the call. An unknown post can never be requeued automatically.
Idempotent updates, deletions and feedback may retry without posting another message.
After a rejected attempt, a reply, progress note or publication uses the stored method and payload
unchanged. A card keeps its method but renders the approval afresh for every attempt. Only one
attempt per approval can be sending. Wait reasons distinguish that card mutex from the shared
channel post slot and an item's retry deadline. Newer updates supersede queued or unknown older updates,
including an older sending update that becomes retryable after its replacement was queued, or
is recovered at startup. Slack metadata
is never stored inside that snapshot: the call adds it from the committed ID and payload hash.
Reconciliation counts only fully read passes, scheduled
from that immutable attempt time at 10, 60 and 120 seconds. Unsuccessful reads never turn an
unknown into a send candidate. Conditional settlements keep late responses from overwriting
manual resolutions or newer attempts. `outbox_channels` shares a durable one-second post
slot across links and cards. Channel ID changes carry the later slot forward, unlink leaves
it alone, uninstall removes it, and maintenance expires slots whose deadline has passed.

## Text

`model/rendering.ts` owns Markdown conversion. It uses the pinned Markdown lexer, supplies
mrkdwn section blocks and an escaped plain fallback, disables automatic parsing and unfurls,
and neutralizes mentions. Only HTTP(S) becomes a link. Email addresses, mailto links,
git remotes, and other autolinked schemes stay plain text. An explicit Markdown link to
another scheme is refused. Before neutralizing broadcasts, it removes the inbox's zero-width
space immediately after @ in both surfaces, so quoted handles and code identifiers return
unchanged. Other zero-width characters stay intact. Whole blocks pack greedily into a section with a blank line
between them, up to 3,000 UTF-16 code units. An oversized block
breaks only between lines, closing and reopening formatting, never inside a link, entity, or
surrogate pair. A line that cannot fit is refused. The rendered sections and the fallback
must each fit 12,000 code units, and a message has at most 50 blocks.
Size refusals name the actual count and its limit. A long-line refusal also gives the
rendered line number and a short preview, so the lead can repair it without guessing.

`model/safety.ts` owns content-free secret refusals and clickable-link checks. The renderer
allows only HTTP(S) links without credentials, local hostnames, or private IP literals.
Private URLs inside code stay plain text and are allowed. Password-bearing URLs are
secrets even in code. These are shape checks, not complete DLP or DNS-based network
classification.

`model/payload.ts` checks a stored lead-authored snapshot at the send boundary without rendering
it again. It requires the renderer's blocks and disabled parsing/unfurls, enforces both size
limits, and rechecks secrets and clickable targets. Approval cards have their own trusted renderer.

## Boundaries and invariants

- Never retry a post blindly, and keep SDK retries off.
- Recheck policy at send time. The link must still be active, a reply must target its request's thread and never a channel's root, and text must pass the secret and length checks.
- Never split or truncate a message. Oversized text is refused with a reason the lead can act on.
