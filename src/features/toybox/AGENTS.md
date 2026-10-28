# Toy Box

The Toy Box client is the bridge's only connection to Toy Box. It reads a channel and runs one of its routines, which is how the bridge wakes a linked channel's lead.

## Domain model

Toy Box delivers a routine run to the channel's lead privately, with the routine's prompt, so a run is the bridge's only way to reach a lead. The lead registers its routines itself and may replace them at any time, so the bridge never stores a routine's ID. Each time it needs one, it reads the channel again and takes the first routine whose prompt runs the command it's looking for (`findRoutine`).

Toy Box shows a channel's routines only in the snapshot its event stream starts with, so `readToyBoxChannel` reads that first frame, keeps the channel's name, its lead's provider and its routines, and closes the stream. `model/index.ts` mirrors only those fields of Toy Box's channel API. Three things read a channel:

- Every wake runs the routine whose prompt runs `toy-box-slack inbox`. `routineRunOutcome` names what Toy Box did with the run: `ran`, `missing` when the channel or its routine is gone, `refused` for any other 4xx, and `failed` for everything else.
- `publish` finds the routine whose prompt runs it and posts once for that routine's latest scheduled run, which `latestScheduledRun` works out in local time, as Toy Box does.
- `link` names the channel in what it asks the owner to approve, and refuses a lead that isn't on Copilot, the only provider known to put the lead's session ID in its shell, which is how the bridge knows the lead is calling. A lead keeps its provider for its channel's life, so link checks it once.

## Boundaries and invariants

- Never post into Toy Box. The lead decides what reaches the Toy Box channel.
- Only talk to a Toy Box on loopback. A non-loopback `TOY_BOX_URL` is refused at startup, and a redirect is never followed.
- A wake never throws. A call that can't connect, times out or reads something unexpected is logged and comes back `failed`, so the wake scheduler retries it while Slack ingestion continues. `publish` and `link` let such a call fail the command instead, for the lead or owner to run again.
