# Outbox

The outbox is the only way the bridge writes to Slack. Replies, progress notes, publications, retractions, reactions, and thread status are queued as outbox items, checked again at send time, posted once with metadata that names the item, and reconciled whenever the bridge can't tell whether Slack accepted them.

## Domain model

An outbox item has an opaque ID carried in the posted message's metadata, a number shown to the lead as `o31`, a kind, a target channel and thread, a payload and its hash, and a state. A publication key makes each periodic publication unique per link, so a routine that runs twice posts once. A repeated reply returns the existing item instead of queuing another.

## Delivery

An item becomes `sending` in a committed transaction before the call is made, so a crash mid-call leaves evidence. A confirmed response makes it `sent`. A timeout, a dropped connection, or an ambiguous error makes it `delivery_unknown`, and reconciliation looks for the item's metadata in the target conversation before anything is sent again. At startup, every item still `sending` becomes `delivery_unknown`. The lead settles what reconciliation can't with `resolve --resend` or `resolve --drop`.

A rate limit pauses only the method Slack limited, until the time Slack named.
The shared bot client owns those cooldowns and installation-wide authentication failures,
including expired tokens. `model/delivery.ts` classifies its outcomes and owns the proof a
post needs: the intended channel and thread, our bot and app, and the item's metadata and
payload hash. Manual resolution may use exact sent text only when metadata is absent,
never when metadata identifies another item. A receipt that shows a reply at the root
requires withdrawal, not confirmation.

`server/posts.ts` posts finals, follow-ups, publications and new approval cards through the shared
bot client, never from inside a write. It refreshes missing or stale channel facts before checking
all authority again, commits sending, then builds metadata from the committed snapshot. Receipt
proof and request settlement share a transaction. A misplaced receipt stores stray and queues its
withdrawal together. Cards bypass a link's audience gate so a suspended link can receive its resume
card, but still require an active installation and the approval's current target.

`model/posting.ts` checks the current installation, link, destination, requester and request
revision. Only explicit follow-ups reach answered, dismissed or expired requests, and none
reach cancelled requests. A destination needs channel facts younger than two minutes with no
invalidation. Both roles are judged when a channel is monitored and published to, against the
owner-approved audiences. This pure gate asks for a refresh or hold rather than guessing.

`server/answers.ts` settles one request inside the transaction that proves a delivery or
changes its source. Proof alone cannot answer a request while its source is unverified.
Intake calls the same function after every revision, and repair after verification, revision or
cancellation, so either order settles the same way without polling. A current confirmed final answers only verified input,
an older final returns the request as updated, and a failed or dropped final returns it as
reply failed unless a replacement still waits. The answered transition queues both reactions
in that transaction. Retraction preserves a valid delivery's proof, while withdrawing a
misplaced post is failure, never a successful delivery.

`server/database.ts` commits each attempt's method, start time, incremented attempt count, and
exact send-time payload before the call. An unknown post can never be requeued automatically.
Idempotent updates, deletions and feedback may retry without posting another message.
After a rejected attempt, a reply, progress note or publication uses the stored method and payload
unchanged. A card keeps its method but renders the approval afresh for every attempt. Only one
attempt per approval can be sending. Newer updates supersede queued or unknown older updates,
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
another scheme is refused. Whole blocks pack greedily into a section with a blank line
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
