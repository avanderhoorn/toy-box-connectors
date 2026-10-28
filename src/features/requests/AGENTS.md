# Requests

Requests are how a Slack message becomes work for the lead and how that work gets answered. This guide follows the request loop end to end: classification and the request lifecycle here, waking the lead in `src/features/wakes`, and the CLI contract the lead answers through in `src/features/commands`.

## Classification and lifecycle

Classification is pure policy over a stored message, its thread, and its link's settings. It runs in the same transaction that stores the message, so a message and the request it opened or joined never disagree, and recovered messages are classified exactly like live ones. A request opens when an allowlisted person mentions the bot, posts a root message in a channel whose request mode is `all`, or follows up in a thread where they asked before. Eligibility comes from the allowlist, the link's modes, and the message's author, and bridge code decides it. The model is never asked whether someone may make a request, and messages from bots, apps, and the bridge itself never open one.

A request belongs to one link and one Slack thread and is shown to the lead as `r14`. Its lifecycle is a state machine whose transitions are named pure functions. An edit or delete of its source updates the request instead of opening another. A request that was dismissed, cancelled, or expired never reopens, so a new ask starts a new request.

## Waking the lead

The wake policy is a pure decision over a link's durable request state, the lead's presence, and the wake budget. The scheduler decides again whenever requests, presence or routines change, when the earliest wait ends, and at least every minute. It wakes the lead privately by running a routine in Toy Box: the link's requests routine for requests, reminders and setup, or a publication series' routine to catch up a missed period. Each wake's kind and outcome are recorded with what the wake changed in one transaction, so a restarted bridge keeps its backoff. It never wakes the lead without durable work waiting, never exceeds the budget, and runs one routine per Toy Box channel at a time, holding the channel until the turn it started shows in presence. A wake that inbox didn't follow backs off and then stalls until new work arrives, held requests get no reminders, and a missed publication is caught up once, not once per missed period.

## The CLI contract

The lead answers through `toy-box-slack`, which sends versioned JSON over the bridge's Unix socket. Each command has zod input and output schemas, a pure Markdown presenter, and a documented exit code, and `--json` prints the same result as data. Output opens with a health banner and ends with the next step. The bridge resolves who is calling: the linked channel's lead may run everything, a member may only read, and any other session is refused. With no session, the caller is the operator, who may read and run setup but never reply or publish. The CLI never talks to Slack or Toy Box itself and keeps no state of its own.

## Boundaries and invariants

- A request's state changes only through its lifecycle functions, in the same transaction as the change that caused it.
- The [outbox](../outbox/AGENTS.md) owns delivery. A request isn't answered until its reply is delivered.
- [Toy Box](../toybox/AGENTS.md) runs the routine, and this loop decides when.
