# Toy Box

The Toy Box client is the bridge's only connection to Toy Box, and it does one thing: wake a linked channel's lead by running a routine in its channel.

## Domain model

Toy Box delivers a routine run to the channel's lead privately, with the routine's prompt, so a run is the bridge's only way to reach a lead. The lead registers that routine itself and may replace it at any time, so every wake reads the channel's routines again, from the first frame of its event stream, and runs the first one whose prompt runs `toy-box-slack inbox`. `model/index.ts` mirrors only the fields of Toy Box's channel API that the bridge reads, and `routineRunOutcome` names what Toy Box did with a run: `ran`, `missing` when the channel or its routine is gone, `refused` for any other 4xx, and `failed` for everything else.

## Boundaries and invariants

- Never post into Toy Box. The lead decides what reaches the Toy Box channel.
- Only talk to a Toy Box on loopback. A non-loopback `TOY_BOX_URL` is refused at startup, and a redirect is never followed.
- A wake never throws. A call that can't connect, times out or reads something unexpected is logged and comes back `failed`, so the wake scheduler retries it while Slack ingestion continues.
