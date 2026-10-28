# Toy Box

The Toy Box client is the bridge's only connection to Toy Box. It keeps the channel catalog the socket API uses to resolve callers, follows each linked channel's event stream, and runs routines to wake the lead.

## Domain model

The catalog maps Toy Box sessions to the channels they lead or belong to. The client reads it when a caller isn't in it and forgets it whenever a linked channel's stream says its members may have changed, so a removed member is refused on their next call. Each linked channel's stream reports routine changes, the lead's presence, when the owner last spoke, and whether the channel still exists. The bridge stores each stream's revision so it can resume. A routine run is the bridge's only way to reach the lead.

## Boundaries and invariants

- Never post into Toy Box. The lead decides what reaches the Toy Box channel.
- Only talk to a Toy Box on loopback. A non-loopback `TOY_BOX_URL` is refused at startup.
- When Toy Box is unreachable, wakes wait and retry while Slack ingestion continues.
- A follower commits each frame, with everything it changes, before it reads the next. The owner speaking releases the holds a link's requests took before, and a deleted channel suspends its link and cancels its active requests.
- A storage error stops the bridge instead of retrying, so launchd restarts it.
