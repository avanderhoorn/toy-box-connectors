# Outbox

The outbox is the only way the bridge writes to Slack. Replies, progress notes, publications, retractions, reactions, and thread status are queued as outbox items, checked again at send time, posted once with metadata that names the item, and reconciled whenever the bridge can't tell whether Slack accepted them.

## Domain model

An outbox item has an opaque ID carried in the posted message's metadata, a number shown to the lead as `o31`, a kind, a target channel and thread, a payload and its hash, and a state. A publication key makes each periodic publication unique per link, so a routine that runs twice posts once. A repeated reply returns the existing item instead of queuing another.

## Delivery

An item becomes `sending` in a committed transaction before the call is made, so a crash mid-call leaves evidence. A confirmed response makes it `sent`. A timeout, a dropped connection, or an ambiguous error makes it `delivery_unknown`, and reconciliation looks for the item's metadata in the target conversation before anything is sent again. At startup, every item still `sending` becomes `delivery_unknown`. The lead settles what reconciliation can't with `resolve --resend` or `resolve --drop`.

A rate limit pauses only the method Slack limited, until the time Slack named.

## Boundaries and invariants

- Never retry a post blindly, and keep SDK retries off.
- Recheck policy at send time. The link must still be active, a reply must target its request's thread and never a channel's root, and text must pass the secret and length checks.
- Never split or truncate a message. Oversized text is refused with a reason the lead can act on.
