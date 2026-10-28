# Toy Box

The Toy Box client is the bridge's only connection to Toy Box. It keeps the channel catalog the socket API uses to resolve callers, follows each linked channel's event stream, and runs routines to wake the lead.

## Domain model

The catalog maps Toy Box sessions to the channels they lead or belong to. Each linked channel's stream reports routine changes, the lead's presence, when the owner last spoke, and whether the channel still exists. The bridge stores each stream's revision so it can resume. A routine run is the bridge's only way to reach the lead.

## Boundaries and invariants

- Never post into Toy Box. The lead decides what reaches the Toy Box channel.
- Only talk to a Toy Box on loopback. A non-loopback `TOY_BOX_URL` is refused at startup.
- When Toy Box is unreachable, wakes wait and retry while Slack ingestion continues.
