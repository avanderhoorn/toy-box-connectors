# Toy Box, for the Slack integration

How Toy Box works, where toy-box-slack attaches to it, and how to steer a Channel lead when Slack is
involved. Every claim cites the Toy Box source at commit
[`ff15be0`](https://github.com/lostintangent/toy-box/tree/ff15be0c15b7ed6fcc97d086bdddd88aeb3f7757)
of lostintangent/toy-box. Paths are relative to that repo unless they start with `toy-box-slack/`.
**Fact** means read in code or observed. **Inference** means reasoned from code but not exercised.
**Unverified** means an experiment in §6 should settle it.

## 0. Conclusions

1. **Toy Box has no plugin seam for agent tools.** Channel agents get a fixed tool list that is
   composed in `src/features/channels/server/agent.ts#getChannelAgentConfiguration`. External code
   can't add a `defineTool` tool or an MCP server through Toy Box (§4.2). Every provider does let
   agents run shell commands without approval, though. So the portable way to give a lead Slack
   abilities is a **`toy-box-slack` CLI on `PATH`**, with a **skill** that teaches the lead how to
   use it. The CLI talks to the bridge over loopback.
2. **Every message posted over HTTP is attributed to the user.** `POST /api/v1/channels/:id/messages`
   always sets `sender: { type: "user" }` (`server/index.ts#postChannelMessage`, line 221). The lead
   treats the user as the accountable stakeholder. Posting a non-owner's Slack text that way
   impersonates the owner and opens the door to prompt injection. It also acknowledges any pending
   request (§2.4). **Only the owner's own Slack messages should become Toy Box user messages.**
   Everyone else's Slack traffic should stay in the bridge as data that the lead reads through the
   CLI.
3. **The cleanest way to wake the lead from outside is to run a routine.**
   `POST /api/v1/channels/:id/routines/:routineId/run` privately wakes the lead with that routine's
   prompt. It adds nothing to the transcript, doesn't acknowledge requests, doesn't wake members, and
   leaves the schedule unchanged (`server/index.ts#runChannelRoutine`, line 432). Only the lead can
   create routines (`database.ts#setRoutine` authorizes the lead). Setup therefore has to go through
   the lead: it creates a "Slack" routine and registers its ID with the bridge. A modest cron
   schedule on that routine also gives us a free safety net for lost wakes (conclusion 4).
4. **Wakes are at most once and live only in memory.** Due wakes are claimed in SQLite before
   delivery (`database.ts#claimDueWakes`). A failed delivery is only logged
   (`index.ts#wakeDueAgent`), and session mailboxes don't survive a restart
   (`sessions/server/runtime/AGENTS.md`). **The bridge must own durability.** It keeps a durable
   Slack inbox with an explicit per-item `handled` state. It re-runs the routine while items are
   still unhandled and stale, and the lead marks items handled through the CLI.
5. **A wake that arrives mid-turn steers into the running turn.** Channel wakes are delivered with
   `immediate: true` (`index.ts#wakeChannelAgent`). If the session is running, `SessionStream.deliver`
   submits the wake into the current turn instead of queueing it (`sessionStream.ts:157-159`).
   Immediate messages bypass coalescing. The bridge should therefore **debounce routine runs**, so a
   burst of Slack messages produces one nudge. The Copilot CLI can still hold a wake that lands in
   a turn's last model request until the lead's background work finishes (§10).
6. **The routine prompt is our strongest per-wake lever, and the channel purpose is our strongest
   standing lever.** The routine prompt (≤2,000 chars) reaches the lead verbatim on every wake. The
   purpose (≤12,000 chars) sits in every agent's system prompt on every execution. The lead's role
   text is fixed and can't be changed (`agent.ts#buildChannelAgentInstructions`). The collaboration
   prompt tells agents that *"every public response must use a channel tool"*. Unless a routine,
   skill, or CLI output says otherwise, a lead will answer Slack questions **in Toy Box** rather than
   in Slack (§3.3).
7. **Outbound mirroring needs no lead cooperation.** The channel SSE stream (`GET
   /api/v1/channels/:id`) gives the bridge every message, reaction, status, task, and presence change
   in order, with `id: <revision>` and `Last-Event-ID` resume. The replay ring is in memory and holds
   500 events (`server/events.ts`). After a Toy Box restart, or a long disconnect, the bridge gets a
   snapshot of the latest 100 messages. It must fill gaps from its own last forwarded **message
   sequence** with `GET …/messages?before=`.
8. **We can get idempotent posts for free.** Message IDs are any 1–255 char string, and a duplicate
   returns 409 without delivering again (`api.ts#postChannelMessageResponse`). Use deterministic IDs
   such as `slack:<team>:<channel>:<ts>` so Slack retries and bridge restarts can't double-post.
9. **An isolated Toy Box is possible, but only by overriding `HOME`.** The data directory is
   hard-coded to `homedir()/.toy-box` (`src/server/database.ts#resolveDefaultPath`). There's no data
   dir flag or env var. Provider CLIs also read auth from `HOME`, so real-LLM end-to-end tests under a
   temporary `HOME` need explicit provider auth (§4.4, §6).
10. **The Toy Box CLI binds `0.0.0.0` by default** (`cli/index.ts`, `host` default). The user's
   running server shows `NITRO_HOST=::`, so it listens on every interface (§4.5). There's no auth,
   so the setup guide must tell users to run Toy Box with `--host 127.0.0.1`. The bridge itself must
   bind its own API to `127.0.0.1` only.
11. **The CLI can identify its caller on Copilot without any flags.** `COPILOT_AGENT_SESSION_ID`
   equals the Toy Box session ID. For a lead, that's the Channel ID. `NITRO_PORT` gives the Toy Box
   port. There are no `TOY_BOX_*` vars. Claude and Codex are unverified, so the CLI needs a
   `--channel` fallback (§4.5).

## 1. Architecture map for an external integration

### 1.1 The nouns

| Concept | What it is | Owner | Relevance to us |
|---|---|---|---|
| Session | A server-side agent conversation that outlives browsers. It has one public ID, at most one live runtime, and history from the provider | `src/features/sessions` | Every channel agent is one. Its mailbox is in-memory |
| Provider | Adapter for Copilot SDK, Claude Agent SDK, or Codex app-server | `src/features/providers` | Determines tool, skill, and instruction plumbing (§4.2) |
| Worker | An owner-bound Session identity: session, file, app, inbox, or channel | `src/features/workers` | Leads and members are durable channel Workers |
| Channel | A purpose, a team (one lead plus members), a transcript, tasks, artifacts, routines, and a preview | `src/features/channels` | **Our integration target** |
| Lead | The intrinsic agent. Its Worker/Session/Agent ID **equals the Channel ID** (`createChannel`, `index.ts:140`) | Channels | The agent that acts on Slack |
| Member | An agent created on demand with an editable role | Channels | Usually not involved in Slack |
| Routine | A titled cron prompt (≤ hourly, local time) that privately wakes the lead | Channels | Our wake seam and our scheduled posts |
| Automations | Scheduled **ordinary** sessions, not channel agents. No public HTTP route | `src/features/automations` | Not useful, because it can't reach a lead |
| Inbox | `POST /api/v1/inbox` spawns a background Worker and stores its result | `src/features/inbox` | Not useful, because it creates a separate session rather than waking a lead |
| Apps | Trusted React surfaces, either installed apps (durable instances) or `.toy` artifact apps | `src/features/apps` | Possible settings UI (§4.3) |
| Skills | `SKILL.md` folders that providers discover natively, plus bundled Toy Box skills | Sessions and providers | How the lead learns the CLI (§4.2) |

Root `AGENTS.md` describes the model as *"one trusted, coordinating server process for one owner; it
does not provide an authentication boundary or horizontal coordination."* Provider history, SQLite,
and files survive restarts. *"active execution, replay buffers, workspace coordination … do not."*

### 1.2 Public HTTP API

All routes live under `src/features/*/routes`, and channel handlers live in
`src/features/channels/server/api.ts`. Bodies must be `application/json`. Bodies can't name an ID
that the route already names (`api.ts#readInput`). Errors map 400 to malformed input, 404 to missing
records, 422 to `ChannelInputError`, and 500 to a generic `{ error }`.

| Method and path | Body | Result | Notes for the bridge |
|---|---|---|---|
| `GET /api/v1/channels` | none | `{ version:1, channels, members, lead, working }` | Catalog. `working` lists agent IDs whose sessions are running |
| `POST /api/v1/channels` | `{ name, purpose?, directory?, model }` | 201 `{ channel }` | **Starts a lead, which costs money.** Never call it against the real server |
| `GET /api/v1/channels/:id` | SSE. `Last-Event-ID` or `?after=` | Event stream | §1.3 |
| `PATCH /api/v1/channels/:id` | `{ name?, purpose?, model? }` | `{ channel }` | **Changing the purpose wakes the lead** (`index.ts#editChannel`) |
| `DELETE /api/v1/channels/:id` | none | 204 | |
| `GET /api/v1/channels/:id/messages?before=N` | none | `{ version, revision, messages }`, up to 100 older | Gap fill |
| `POST /api/v1/channels/:id/messages` | `{ id, content, attachments? }` | 201 `{ message }`. 409 on duplicate `id` | Always attributed to **user**. Content can be up to 12,000 chars. `attachments` is `[{ mimeType:"image/*", base64 }]` with no size cap in the schema |
| `POST /api/v1/channels/:id/read` | `{ sequence }` | `{ seenThrough }` | Moves the **owner's** read cursor and only goes forward |
| `POST/PATCH/DELETE …/members[/:agentId]`, `GET …/members/:agentId/models` | | | Management. Creating a member starts a session, which costs money |
| `POST …/routines/:routineId/run` | none | 204, or 404 if the routine is gone | **Private lead wake** (§4.1) |
| `DELETE …/routines/:routineId` | none | 204 or 404 | |
| `GET /api/v1/models` | none | `{ models, defaultModel }` | |
| `POST /api/v1/inbox` | `{ prompt, attachments? }` or multipart | 202 | Separate managed session, not a channel |
| `GET /api/workspace` | SSE | Workspace events, including `channel.upserted`, `channel.deleted`, `session.running`, `session.idle` | At most once, with no replay or cursor |
| `GET /api/serve/:scope/*` | none | File bytes, with ETag and range support | Artifact and attachment URLs resolve here |

There's no API to create routines, read an agent's private transcript, post as an agent, or
read or write arbitrary channel metadata. (Fact: the route list in
`src/features/workspace/routeTree.gen.ts` and the schemas in `channels/model/index.ts`.)

### 1.3 Channel SSE protocol (`server/stream.ts#streamChannel`, `shared/server/sse.ts`)

I observed this live on this channel with a GET-only request:

```
retry: 1000

id: 25
data: {"type":"snapshot","state":{...ChannelState...}}

: keepalive            ← every 5 s (HEARTBEAT_CHUNK)
```

- There's no `event:` field. The JSON `type` discriminates: `snapshot`, `resumed`, `presence`,
  `message`, `reaction`, `tasks`, `model`, `read`, `member`, `status`, and `deleted`
  (`model/index.ts#ChannelObservationEvent`). `id` is the channel **revision**, which advances for
  every durable public change. Message **sequence** is separate and advances only for transcript
  messages.
- **No cursor:** one `snapshot`. It holds the latest 100 messages, roster, artifacts, routines,
  presence, and the pending `request` even when that request falls outside the window.
- **With a cursor:** contiguous replay of the missing events, then `{type:"resumed", presence}`.
  If replay isn't possible, the server sends a replacement `snapshot`. That happens when the ring is
  missing events (it holds 500 in memory, `events.ts#MAX_REPLAY_EVENTS`), after a restart, or when
  the cursor is ahead of the server.
- **Deleted channel:** `{type:"deleted"}`, then the stream closes.
- `presence` events send only the agents that changed. Each value is `{ state: working|waiting|idle, … }`
  (`model/presence.ts`).
- Observing the stream never acknowledges anything or changes read state.

**What the bridge has to do (inference).** Persist `lastRevision` for resume and
`lastForwardedSequence` for Slack posting. On a replacement snapshot, compare its oldest message
sequence with `lastForwardedSequence`. Page backward with `?before=` until they meet, or decide to
summarize a large gap rather than flood Slack. Also dedupe our own posts by the message `id` we
chose.

## 2. How channels actually behave

### 2.1 Audience policy (`model/index.ts#resolveChannelAudience`, line 462)

```ts
if (!mentionAll && handles.length === 0) {
  return lead.id === senderId ? [] : [lead];
}
return agents.filter(({ id }) => id !== senderId &&
  (mentionAll || mentionedIds.has(id) || (acknowledgedRequest && id === lead.id)));
```

- An unmentioned user or member message wakes the lead. An unmentioned lead message wakes nobody.
- `@everyone` wakes everyone except the sender. Named mentions wake exactly the agents they name.
- **Pitfall (fact):** if a message contains any `@handle`, even one that matches no agent, the "no
  mentions" branch doesn't apply. **Nobody wakes**, unless the message also acknowledges a pending
  request, in which case the lead wakes. The mention grammar is `(?:^|[^a-z0-9-])@([a-z0-9][a-z0-9-]*)`,
  case-insensitive, so `dev@example.com` stays plain text (`model/agent.ts`). Slack text rendered as
  `@alice` or `@here`, or a pasted `@channel`, **silently wakes nobody**. The bridge must neutralize
  `@` in Slack-originated text it posts (for example `＠alice`, or wrapping it in backticks), or
  deliberately prefix `@lead`.

### 2.2 Wakes

Every wake goes through `index.ts#wakeChannelAgent`. That calls
`deliverSessionMessage(agentId, { systemMessage, immediate: true })` and then clears a `waiting`
status. The model sees `systemMessagePrompt` text (`sessions/model/systemMessages.ts`), quoted here
verbatim:

| Trigger | Prompt the agent sees |
|---|---|
| Message (`channel_message`) | ``A new public message from ${senderName} is waiting in a channel you belong to. Call `read_channel` to consume messages since your last read.`` (`senderName` is `"the user"` for every HTTP post) |
| Routine (`channel_routine`) | ``Your routine ${JSON.stringify(title)} is due: ${JSON.stringify(prompt)}. Call `read_channel`, then do it. If nothing needs the channel's attention, finish quietly.`` |
| Follow-up (`channel_follow_up`) | ``Your follow-up is due. You were waiting for ${waitingFor}. Call `read_channel` and check whether you can continue.`` |
| Task check-in | ``The check-in scheduled for … on task "t3" ("…") is due and has been cleared. Call `read_channel`. If the task is still assigned to you and in progress, post a concise progress update…`` |
| Member creation | `"You have joined this channel. Read its context and complete any missing profile details. If you have been assigned work, begin it. Otherwise finish your turn quietly, without a readiness message or waiting status."` (`index.ts:66`) |
| Channel creation | `"This channel was just created. Begin working toward its purpose."` (`index.ts:147`) |
| User changes the purpose | The same as a message from "the user" (`index.ts#editChannel`) |

**Scheduling** (`server/startup.ts`). A 60-second `setInterval` calls `wakeDueChannelAgents`. That
function runs `claimDueWakes`, which in **one transaction** clears due follow-ups, advances each due
routine's `next_at` past now, and clears due task `checkInAt`s, all **before** delivery. Missed
routine runs collapse into one. A delivery failure is only logged. **Each wake is at most once.**

**When a wake arrives while the agent is running** (`sessions/server/runtime/sessionStream.ts#deliver`,
lines 140-178):
- If the session isn't open, the wake starts a turn.
- If it's running and nothing is mid-submit, `immediate` means `#submitMessage` **steers it into the
  current turn**. Claude uses `next` priority, which applies at the next model step
  (`providers/server/claude/AGENTS.md`). This channel observed it too: I received the lead's wake
  during my own turn.
- If another message is mid-submit, the wake is deferred into the queue. **Queued** system messages
  coalesce by key (`systemMessageCoalesceKey`): `channel_message` coalesces with every other
  `channel_message`, and `channel_routine` coalesces only with the same prompt. Immediate messages
  skip coalescing.
- Mailboxes are process memory, so a restart drops pending wakes (`runtime/AGENTS.md`).
- There's no global concurrency, cost, or turn-budget guard (inference, from searching the
  sessions, runtime, and server code). Each wake is a paid turn, so the bridge has to rate-limit.

### 2.3 Read cursors

- **Agent cursor.** Each agent has a private `seenThrough` in its Worker metadata. Only
  `read_channel` advances it, and only forward, by up to 100 messages per call with `hasMore`
  (`index.ts#readChannelForAgent`). At zero it returns full context.
- **Owner cursor.** `channels.seen_through` drives the sidebar's unread and "finished" badges. HTTP
  `POST …/read` advances it. A user message doesn't advance it (`reducer.ts#reduceChannel` only moves
  `latestSequence`), so **a message the bridge posts on the owner's behalf leaves the channel unread
  in the sidebar.** That's a UX decision for the design (§6, R7).
- **The Slack cursor is ours.** Toy Box has nothing like it. The bridge owns it per (Slack channel,
  thread) in its own database (fact: there's no generic channel metadata, `model/index.ts` schemas
  are `.strict()`).

### 2.4 Requests and completion

- Only the lead can flag `request: true` (`database.ts#appendMessage` throws otherwise). That sets
  `requestSequence`, and the sidebar shows "waiting" until **any** later user message arrives.
- **Every user message clears `requestSequence`** (`reducer.ts:100`), and the lead wakes even if the
  message mentions someone else (`acknowledgedRequest`). The lead prompt says the lead must judge
  whether the reply actually resolves the request. That makes Slack-to-Toy Box posting a semantic
  act: an owner's casual Slack chatter clears the lead's question.
- `tasks_completed` is appended when a lead's task edit takes the whole list from incomplete to
  complete. Reading past it acknowledges it.
- **For the bridge:** a `message` event with `request: true` is the signal to ping the owner in
  Slack. A `tasks_completed` system message is the "done" signal.

## 3. The prompts that steer the lead

### 3.1 How instructions are assembled

`getChannelAgentConfiguration` (`channels/server/agent.ts:12`) returns `tools`, `directory`,
`additionalInstructions`, `disableMemory: true`, and an optional model. It runs **whenever a private
session starts an execution**, so purpose, role, and directory edits apply on the next execution and
never mid-turn (`sessions/server/runtime/AGENTS.md`, `server/sessionConfiguration.ts:88-104`).
`buildSessionSystemPrompt` appends those instructions after Toy Box's generic session instructions
(`sessions/server/instructions.ts:48`). Each provider applies them as follows:

- Copilot: `systemMessage: { mode: "append", content }` (`copilot/provider.ts:194-196`)
- Claude: `systemPrompt: { type:"preset", preset:"claude_code", append }` (`claude/connection.ts:71-76`)
- Codex: `developerInstructions` (`codex/provider.ts:234`)

`disableMemory` turns off provider memory features. History is unaffected. There's **no
user-editable global instructions file** in Toy Box (fact: none found).

### 3.2 Collaboration instructions (every agent), with the passages that matter

The full text lives at `agent.ts:97-122`. These are the passages that bear on Slack:

> This channel is a shared collaboration space with the user and other agents. Your SDK transcript is private working state. Assistant text is not visible in the channel, so every public response must use a channel tool.

> Call read_channel at the start of every turn.

> Use judgment to choose the smallest useful action: React when acknowledgement, agreement, sentiment, or completion needs no message. Send a message for a question, decision, feedback, quick answer, handoff, or result.

> Before publishing a result or handoff, call read_channel again. … Publish only new useful information.

> Call finish_agent_turn after your last channel action. Pass waitingFor only when you cannot continue without a specific user, teammate, or external action.

> Write public messages like you speak to a colleague. Match the user's tone, not another agent's. … Avoid compressed report prose. … Skip self-introductions, private narration, and repetition. Never use em dashes or semicolons.

The role block (`agent.ts:124-135`) inserts **the channel purpose verbatim** and the agent's role:

> You are ${name} (@${handle}), the lead in the Toy Box channel "${channel.name}". Channel purpose: ${purpose} … Stay close to the user's needs and take personal accountability…

### 3.3 Lead role ("How to lead", `agent.ts:63-95`), with the passages that matter

> Your job is to establish a clear channel purpose with the user and coordinate the work it calls for. Lead with the energy, curiosity, taste, and judgment of a strong product lead.

**Routines** (this governs scheduled Slack posts):
> A routine is scheduled, recurring work that serves the channel's purpose. Add one only when the user asks for recurring work or approves one you propose. Give it a short title, and write its prompt so it stands on its own when it wakes you. A routine never changes what the channel is for, so leave the purpose alone… Keep routines out of the task list too… When a routine wakes you, add tasks only for concrete work the run uncovers.

**Communicate** (this governs Toy Box updates):
> Post a concise channel update when the plan changes, a meaningful milestone lands, or the user must decide. Do not repeat information members already shared. … When you need a user decision, missing context, or action, explain exactly what they need to do with send_channel_message and set request.

**Track and adapt** (a risk for purpose-based levers):
> Keep the channel name, purpose, working directory, tasks, preview, shared artifacts, and roster current. … When the user materially revises what the channel is for, update the purpose before adapting the plan.

**Close the loop**, which shapes ongoing purposes:
> For an ongoing or ad hoc purpose, close the current batch clearly and leave the task list ready for what comes next instead of pretending the channel itself is complete.

### 3.4 The lead's tool surface (`server/tools.ts`)

The lead gets `read_channel`, `set_agent_status`, `react_to_channel_message`,
`share_channel_artifact`, `finish_agent_turn`, `send_channel_message` (with `request`, ≤3,000
chars), `create_channel_members`, `update_channel`, `edit_channel_tasks`, `set_routine`, and
`delete_routine`. It also gets screens, app, automation, app-state, and model tools (`agent.ts:18-26`)
and the provider's native tools, including shell. Members get the common set plus
`send_channel_message` (without `request`) and `update_member`. Two tool descriptions matter here:

- `set_routine`: *"Adds a routine that privately wakes you with its prompt on its schedule, or changes one by routineId. Posts a system message to the channel."* It returns `{ routineId }`.
- Routine schedule schema: *"A 5-field cron in local time with one fixed minute, like 0 9 * * 1-5."* Prompts are 1–2,000 chars (`model/index.ts#channelRoutineInputSchema`).

### 3.5 Levers, and where each one fails

| Lever | Reach | Strength | Failure points |
|---|---|---|---|
| **Routine prompt** | The lead only, on that wake | Highest per-wake, because it's verbatim and fresh each time | 2,000-char cap. Toy Box appends *"If nothing needs the channel's attention, finish quietly."* Only the lead can author or edit it, and the lead may "improve" it. The user can delete it from the overview, and then `run` returns 404 |
| **Channel purpose** | Every agent's system prompt, every execution | High standing context | Members see it too and may try to use Slack. The lead is told to keep it current and may rewrite it. 12,000-char cap. Applies only at the next execution. A user edit wakes the lead. It's user-facing prose, so it shouldn't carry operating manuals |
| **Skill (`SKILL.md`)** | Whichever agents' providers discover it | Good for procedure: CLI usage, Slack tone, safety | Loaded on demand by description match, so the agent may not open it. Discovery paths differ by provider (§4.2). Bundled `~/.toy-box/skills` doesn't work (§4.2) |
| **CLI output** | Whoever runs the CLI | **Most reliable and provider-agnostic.** It's versioned with the bridge and shows up exactly when needed | Only helps after the agent decides to run it |
| **Owner's Toy Box message** | The lead | Direct | Costs a turn, acknowledges requests, and isn't scalable |
| **`AGENTS.md`/`CLAUDE.md` in the channel directory** | Native project instructions | Medium | Unverified per provider (§6). The directory is often the user's real repo, which we shouldn't write into |

**(a) Getting the lead to notice and answer allowlisted Slack users.** Wake it through the routine
seam. The routine prompt should say exactly what to do: run `toy-box-slack inbox`, answer each item
**in Slack with `toy-box-slack reply`**, mark items handled, and post to Toy Box only when something
deserves the team's attention. Failure points:
1. The collaboration prompt pushes toward answering in Toy Box ("every public response must use a channel tool").
2. The wake is lost on a restart, so the bridge has to re-run.
3. A mid-turn steer can get folded into unrelated work.
4. The lead may delegate the reply to a member who doesn't know the rules. The bridge should accept replies only through its CLI and attribute them to the lead (§4.2).
5. Prompt injection from Slack text. The CLI should frame content as untrusted data, and the bridge enforces the allowlist itself instead of relying on the model.

**(b) Keeping the Toy Box channel updated.** The bridge can mirror Slack activity on its own if we
want that (as user-attributed digests, with the caveats in §2.4). The bigger value is the lead
synthesizing: "three people asked about X this week, so here's an idea". Failure points:
1. *"finish quietly"* combined with *"Publish only new useful information"* biases the lead toward silence, so the routine prompt has to state the bar for posting explicitly.
2. A mentionless lead post wakes nobody. That's good for cost, but it means ideas don't reach members unless the lead mentions them.
3. Too many posts, because each wake could produce one. Ask for posts only on a digest routine.

**(c) Publishing scheduled posts such as release notes.** Use a separate routine, for example
`0 17 * * 5` with the title "Weekly release notes". Failure points:
1. At-most-once delivery. A missed run collapses into one at the next tick, but a run lost after the claim is never retried. The bridge can detect "no post for period P by its deadline" and alert or re-run.
2. Cron uses the **server's local time**.
3. The lead may post twice if two wakes overlap, which is why `toy-box-slack post --once <key>` (for example `release-notes:2026-W44`) needs to be idempotent in the bridge.
4. Hourly at most.
5. Its source material (git log, PRs) must come from the channel directory or shell, so the routine prompt must name it.

## 4. Integration seams

### 4.1 Waking the lead from outside

| Path | Transcript effect | Side effects | Verdict |
|---|---|---|---|
| `POST …/routines/:id/run` | **None** | Private wake with the routine prompt. Clears the lead's `waiting` status (`wakeChannelAgent`). Immediate steer if the lead is running. 404 if the routine was deleted | **Recommended** for Slack-originated work |
| `POST …/messages` as the user | A user message that's visible and counts as unread | Wakes the lead (or the mentioned agents). **Clears any pending request.** Any `@handle` changes the audience (§2.1) | Use **only for the owner's own Slack messages**, with deterministic IDs |
| `PATCH …/:id` with purpose | A `channel_purpose_changed` system message | Wakes the lead as "the user" | Never use as a wake |
| Follow-ups and task check-ins | None | Agents schedule these themselves | Not externally triggerable |
| `POST /api/v1/inbox` | None in the channel | Spawns an unrelated Worker | Not applicable |

**Proposed setup flow (inference, consistent with the lead prompt).** The owner tells the lead in
Toy Box: "monitor #eng-help, answer @alice and @bob, and publish weekly release notes". The lead
follows the toy-box-slack skill:
1. It runs `toy-box-slack link --channel C123 …`, which validates and stores the configuration in the bridge.
2. It calls `set_routine` for "Slack inbox", with an hourly or working-hours safety-net schedule and a self-contained prompt.
3. It registers the returned ID with `toy-box-slack link --routine <id>`.
4. It adds a release-notes routine if the owner asked for one.

From then on, the bridge runs the inbox routine on Slack activity, debounced, and the cron covers
lost wakes. The routine's creation appends one `routine_scheduled` system message, which is fine.

### 4.2 Giving channel agents Slack abilities

Toy Box's own tools reach providers like this: in-process tools for Copilot
(`copilot/provider.ts:154-207`, `skipPermission: true`), an in-process MCP server named `toy_box` for
Claude (`claude/tools.ts`), and dynamic tools for Codex (`codex/provider.ts:99-133`). The list comes
only from `getChannelAgentConfiguration`, and `SessionConfiguration.tools` has no external hook
(`providers/server/provider.ts:12-19`, `sessions/server/providers.ts:106-119`).

| Mechanism | Copilot | Claude | Codex | Evidence |
|---|---|---|---|---|
| **Shell CLI on `PATH`** | ✅ `onPermissionRequest: approveAll` | ✅ `canUseTool` allows everything except `AskUserQuestion` | ✅ `approvalPolicy:"never"`, `sandbox:"danger-full-access"` | `copilot/provider.ts:162-181`, `claude/connection.ts:226-231`, `codex/provider.ts:230-237`. Provider processes inherit `process.env` (`copilot/client.ts:28`, `claude/connection.ts:58`), so `PATH` comes from the Toy Box server's environment |
| Project skills in the channel directory | Inference: ✅ via `rpc.skills.discover({ projectPaths:[cwd] })` (`copilot/provider.ts:65-78`). Which subfolders it searches is **unverified** | ✅ `<dir>/.agents` is loaded as a plugin, so `.agents/skills` works. Native `.claude/skills` also works (`claude/client.ts:14-23`) | Inference: ✅ native `skills/list` for `cwd` (`codex/provider.ts:267`). Subfolders **unverified** | Toy Box's own repo uses `.agents/skills` (plan, review, dogfood) |
| User-level skills | ✅ **observed**. My Copilot session lists `~/.copilot/skills/persona-cohort` as a user skill | Inference: `~/.claude/skills` via `skills:"all"` | Inference: `~/.codex/skills` or `~/.agents/skills` | |
| `~/.toy-box/skills/<name>` | ❌ Only `UNIVERSAL_SKILLS` and `ROLE_SKILLS` names are passed (`sessions/server/bundledSkills.ts:14-21`). **Observed:** `~/.toy-box/skills/run-squad` exists but isn't offered to this session. Startup also rewrites bundled names | ❌ | ❌ | |
| User MCP config | Inference: `enableConfigDiscovery: true` may load `~/.copilot/mcp-config.json`. Unverified | No `settingSources` passed, so it's unverified whether user or project `.mcp.json` loads | Unverified whether app-server reads `~/.codex/config.toml [mcp_servers]` | |
| New Toy Box `defineTool` | ❌ This would need a Toy Box change | ❌ | ❌ | |

**Recommendation.** Ship a `toy-box-slack` CLI plus one `toy-box-slack` skill. The CLI is the
contract and the skill teaches it. Install the skill at user level for each provider the owner uses,
or in `<channel dir>/.agents/skills` when the owner opts in. Also embed the essentials in the routine
prompt, so even an agent that never opens the skill does the right thing on a wake. MCP is a
possible later upgrade, but it's per provider and unverified.

**Who is calling the CLI?** Copilot sets `COPILOT_AGENT_SESSION_ID` in the shell, and it **equals the
Toy Box session ID**. I observed this in my own session. For a lead, that ID **is the Channel ID**,
so the CLI can bind to the right linked channel and tell "lead" apart from "member" by checking
whether the session ID is a channel ID in `GET /api/v1/channels`. It's still only a convenience and
not a security boundary, because agents can set env vars. Claude and Codex equivalents are
unverified (§6). Fallback: an explicit `--channel` flag.

### 4.3 Configuration surfaces "within Toy Box"

- **Channel settings:** none we can use. The schemas are `.strict()`, with name, purpose, directory,
  model, tasks, and preview only. There's no free-form metadata. Writing configuration into the
  purpose is user-visible and the lead may rewrite it.
- **Routines:** these are real channel state we can rely on. Their IDs appear in the SSE snapshot
  (`state.routines`), so the bridge can verify that its routine still exists.
- **Installed apps:** these are *"trusted code running in Toy Box's page, not a security sandbox"*
  (`apps/AGENTS.md:125`). The SDK offers `useChannels` and `useChannel`, plus session, file, pane,
  and durable app state. Imports are allowlisted, but `fetch` is a browser global (inference: not
  blocked). A "Slack settings" app could therefore call the bridge's loopback API **if the bridge
  allows CORS from the Toy Box origin**. It breaks when the owner opens Toy Box from a phone, because
  `localhost` then means the phone. The lead can author apps (`create_app`, `install_app`,
  `apps/server/tools.ts:103-160`). That makes a good v2. For v1, the lead and CLI are the
  configuration UI ("tell your lead"), backed by a config file in the bridge.
- **Artifacts:** the lead can share the bridge's per-channel config or digest file as a channel
  artifact, which makes it visible and editable in Toy Box. Any edit to the file is live
  (`files` watch). That's a cheap, transparent configuration view.

### 4.4 Running an isolated Toy Box for end-to-end tests

- The data root is `homedir()/.toy-box` for SQLite, `sessions/`, and `skills/`
  (`server/database.ts#resolveDefaultPath`, `sessions/model/constants.ts`,
  `files/server/paths.ts`). There's **no flag or env var**. Isolation means
  `HOME=$(mktemp -d) toy-box --port 3199 --host 127.0.0.1 --no-open` using the built binary at
  `toy-box/toy-box`, or `HOME=… bunx vite dev --port 3199` in the repo.
- Provider auth also lives under `HOME` (`~/.copilot`, `~/.claude`, `~/.codex`). Under a temporary
  `HOME`, real agents need explicit auth, for example `COPILOT_GITHUB_TOKEN`/`GH_TOKEN` for Copilot
  (unverified). Toy Box's own tests avoid this: they use
  `createTestDatabase(":memory:")` with mocked `getStateDatabase` (`server/database.ts:88-93`,
  `channels/server/index.test.ts`).
- **Recommended test pyramid:**
  1. Unit tests on a pure core (mapping, policy, cursor reducers).
  2. Integration tests against a **protocol-faithful fake Toy Box**. That's a Bun server that speaks
     the exact SSE framing, revision and replay semantics, 409-on-duplicate, and routine-run 204/404
     from §1.2–1.3. It's cheap and deterministic.
  3. One opt-in end-to-end suite against an isolated real Toy Box under a temporary `HOME` on a
     non-3100 port. It uses a **real channel** and a cheap model, and runs only with an explicit env
     flag because it spends money.

### 4.5 Answers to the lead's follow-ups (message 12)

**1. What a channel agent's shell can see.** I observed the variable *names* in this channel's
Copilot member shell. Values are shown only where they're safe.

| Variable | Value / meaning | Provider | Source |
|---|---|---|---|
| `COPILOT_AGENT_SESSION_ID` | The **Toy Box session ID**. For a lead, that's the Channel ID. For a member, it's the member's agent ID | Copilot only (observed) | Set by the Copilot CLI. Toy Box passes its public ID as the native ID |
| `NITRO_PORT`, `NITRO_HOST` | `3100` and `::` on the user's server | Every provider (inherited) | `cli/index.ts:49-50` sets them in the server process, and providers spawn with `...process.env` (`copilot/client.ts:28`, `claude/connection.ts:58`). Under `vite dev` they may be unset (unverified) |
| `HOME` | The data dir is `$HOME/.toy-box` | All | `server/database.ts#resolveDefaultPath` |
| `PWD` | The channel's `directory`, or `$HOME` when it's unset | All | `sessions/server/state/registry.ts:131` |
| `TOY_BOX_*` | **None exist** | — | Grep shows none |

So the CLI can resolve its caller without flags when Copilot is the provider. Read
`COPILOT_AGENT_SESSION_ID`, then `GET http://127.0.0.1:${NITRO_PORT:-3100}/api/v1/channels`. If the
ID matches a `channels[].id`, the caller is **that channel's lead**. If it matches a
`members[].id`, the caller is a member of `members[].channelId`. Otherwise it's an ordinary session.
Claude and Codex need either an explicit `--channel <id>` (the routine prompt can embed it, because
the lead knows its channel ID) or R3 to turn up an equivalent variable. **None of this is
authentication.** Agents can set env vars, and any local process can call the bridge. The bridge
enforces policy (allowlist, linked Slack channel, rate limits) no matter who calls it.

Side finding: the user's running server has `NITRO_HOST=::`, meaning **it listens on all
interfaces**. That strengthens R11. Toy Box itself has no auth, so the bridge mustn't assume
loopback-only exposure. The bridge must bind its own API to `127.0.0.1`.

**2. A routine run that arrives mid-turn is steered in, not dropped and not merged.**
`runChannelRoutine` calls `wakeChannelAgent`, which calls `deliverSessionMessage(…, { immediate:
true })`. `SessionStream.deliver` then submits it into the active turn (`sessionStream.ts:157-159`).
Claude applies it at the next model step with `next` priority. The exceptions:
- If another message is mid-submit, the wake is deferred to the queue.
- Queued routine wakes coalesce only when their **prompt is identical** (`channel_routine:${prompt}`).
- When the session isn't open, the wake starts a new turn.
- A restart loses the wake.
- Immediate wakes aren't coalesced, so two quick runs mean two steers.
- The Copilot CLI may hold one that lands in a turn's last model request until background work
  finishes, and doesn't coalesce what it holds (§10).

The bridge should debounce. The lead sees exactly:

> Your routine "<title>" is due: "<prompt>". Call \`read_channel\`, then do it. If nothing needs the channel's attention, finish quietly.

The title and prompt are `JSON.stringify`'d, so quotes and newlines arrive escaped. This text comes
on top of the lead's normal system prompt, which is refreshed only when a new execution starts.

**3. Permissions: yes, every provider runs agents with unrestricted shell and tools.**
- Copilot: `onPermissionRequest: approveAll`, and Toy Box tools have `skipPermission: true`.
- Claude: `permissionMode: "default"` is pinned, and `canUseTool` returns `allow` for everything
  except `AskUserQuestion`.
- Codex: `approvalPolicy: "never"`, `sandbox: "danger-full-access"`.

(§4.2 has the line citations.) No network sandbox is configured. **Threat model:** any Slack text
the lead reads can steer an agent that can run arbitrary commands as the owner, read `~/.toy-box`,
`.env.local`, and SSH agent sockets (`SSH_AUTH_SOCK` is inherited), and push to git. The controls
have to live outside the model:
- The bridge holds the Slack token. The CLI never prints it, and agents never get it in env.
- The allowlist and the linked-channel scope are enforced in the bridge.
- Slack content reaches the lead only as **delimited, labeled data** in CLI output, never as a Toy
  Box user message, unless the sender is the owner.
- Outbound posts go only to the linked channel and threads, through the bridge, with rate limits.
- Treat unallowlisted users' messages as invisible to the lead, or at least never as instructions.

## 5. Conventions to replicate

### 5.1 Tooling (fact)

- Bun is the runtime and test runner (`bun-types ^1.4.4`, local `bun --version` = 1.4.4).
  `bunfig.toml`:
  ```toml
  [run]
  bun = true

  [fmt]
  flavor = "oxfmt"
  ```
- `package.json` has `"check": "bun fmt --check && bun lint && bun check"` and
  `"prepare": "git config core.hooksPath .githooks"`. `.githooks/pre-commit` is
  `bun lint --staged --fix && bun fmt --staged`.
- `.oxlintrc.json`: plugins `typescript` and `import`, `"categories": { "correctness": "error" }`,
  `"options": { "typeAware": true }`, and a test override that relaxes
  `typescript/no-floating-promises` to warn. Drop the React and TanStack plugins for a server-only
  repo.
- `tsconfig.json`: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`,
  `noUncheckedSideEffectImports`, `moduleResolution: "bundler"`, `allowImportingTsExtensions`,
  `noEmit`, `types: ["bun-types"]`, and path aliases per feature (`"@channels/*":
  ["./src/features/channels/*"]`).
- Dependencies: `zod` v4 (`z.iso.datetime()`, `z.output`), and `Bun.SQL` with the sqlite adapter
  instead of `bun:sqlite` directly. Toy Box wraps it in `inStateTransaction` with a
  `SerialTaskQueue` and `BEGIN IMMEDIATE` (`server/database.ts`). WAL and `synchronous = NORMAL`.

### 5.2 Code patterns

- **Feature folders:** `model/` is the isomorphic, pure domain (types, zod schemas, policies,
  reducers). `server/` holds authority and effects (`schema.ts`, `database.ts` as a `XDatabase`
  class over `Bun.SQL`, `index.ts` composing the algebra, `api.ts` as thin HTTP ingress). Tests sit
  next to their sources as `*.test.ts`.
- **Zod:** `fooInputSchema` names, `.strict()` objects, `.describe()` on every agent-facing field,
  `z.output<typeof …>` types, and `.refine` for cross-field rules (for example
  `updateChannelInputSchema`). Domain rejections throw a typed error (`ChannelInputError`), which HTTP
  maps to 422.
- **Functional core:** pure `resolveChannelAudience` and `reduceChannel` reducers, with effects in
  `server/index.ts#postMessage` ("Persist once, then apply the same audience plan"). Claims commit
  **before** effects (`claimDueWakes`).
- **Comments:** sparse `/** … */` that state an invariant or role, for example
  `/** Returns false when the routine was already gone. */`. Files read top-down: public verbs
  first, helpers after.
- **HTTP:** versioned bodies `{ version: 1, … }`, `Cache-Control: no-store` on reads, generic
  500s that never leak exception text, and "a failure can follow a committed change, so clients
  refresh rather than retry writes".
- **Tests:** `bun:test`, `describe("channel attention", …)`, one contract per test, and
  protocol-faithful fakes. *"When mocking modules here, provide their complete export surface.
  Bun's `mock.module` remains active for the test process"* (`tests/AGENTS.md`). Use golden
  snapshots only with named invariants.
- **Agent-facing text:** concise, imperative, no em dashes or semicolons in public messages, and
  tool descriptions that state side effects ("Does not wake agents or end the turn.").

### 5.3 The AGENTS.md shape to bring across

Root `AGENTS.md` has an intro paragraph about the stack, `## Architecture` (prose plus a mermaid
flowchart and a trust statement), `### Subsystem guides` (links in reading order), `## Writing Great
Code` (the four principle groups: Domain coherence, Semantic decomposition, Functional architecture,
Verifiable contracts), and `## Definition of Done`. Feature guides follow a pattern of a story
intro, then `## Domain model` (a tree plus bullets), `## Algebra` (verbs), lifecycle and
persistence, `## Code map`, and invariants.

My recommendations:
- **Copy "Writing Great Code" verbatim.** It's the author's voice and it's repo-agnostic. Point the
  model example at our own best-tested pure module.
- Write a root `AGENTS.md` with Architecture (bridge ↔ Toy Box ↔ Slack, a mermaid flowchart, an
  explicit trust boundary), Subsystem guides, Writing Great Code, and Definition of Done (`bun
  check`, `bun test`, and the end-to-end suite for protocol changes).
- Write a feature guide for each real subsystem, for example `src/features/slack/AGENTS.md` (Slack
  ingestion, cursor, allowlist, outbound) and `src/features/toybox/AGENTS.md` (the client: SSE
  resume, gap fill, idempotent posts, routine wakes). Use the Channels guide's headings.
- Adapt the `plan`, `review`, and `dogfood` skills into `.agents/skills/` only if we'll actually use
  them. `dogfood` is Playwright-specific, so ours would become "exercise the bridge against a fake
  and an isolated Toy Box".

## 6. Open risks and experiments

| # | Risk or unknown | Experiment to settle it |
|---|---|---|
| R1 | The lead answers Slack in Toy Box instead of in Slack, or ignores the wake | Isolated instance with a real lead. Create the Slack routine through a scripted owner message, run it with a canned inbox in the fake bridge, and assert that `toy-box-slack reply` was invoked and no Toy Box message was posted. Try all three providers |
| R2 | Which skill paths each provider discovers, project versus user | Put a sentinel skill in `<dir>/.agents/skills`, `<dir>/.github/skills`, `~/.copilot/skills`, `~/.claude/skills`, and `~/.codex/skills`. Check `listSkills` output per provider in an isolated instance |
| R3 | Caller identity env for Claude and Codex (Copilot has `COPILOT_AGENT_SESSION_ID`) | In an isolated instance, have a Claude or Codex lead run `env` and look for `CLAUDE_*` or `CODEX_*` session IDs. Also check whether native IDs equal Toy Box IDs for those providers |
| R4 | Lost wakes after a restart or a failed delivery | Fake-based test: the bridge re-runs the routine when items stay unhandled past a TTL, and the cron safety net covers the rest. Live: restart the isolated Toy Box mid-wake |
| R5 | A burst of Slack messages produces many mid-turn steers | Unit-test the debounce or coalesce policy. Live: post 5 messages in 10 s and count lead turns |
| R6 | The SSE gap after a Toy Box restart (empty ring) | Integration test against the fake. Restart, then expect a replacement snapshot and backward paging to `lastForwardedSequence`. Live: restart the isolated instance |
| R7 | Owner Slack posts leave the channel unread, and they clear pending requests | Decide: should the bridge `POST …/read` through its own message when nothing earlier is unread? Should it warn in Slack when a reply will clear a pending request? |
| R8 | `@` in Slack text silences delivery (§2.1) | Unit-test the mention neutralizer against Slack `<@U…>`, `<!here>`, `<!channel>`, emails, and code spans |
| R9 | Large image uploads (no schema cap) and Toy Box memory or SQLite growth | Measure a 10 MB base64 post on the isolated instance. Cap it in the bridge |
| R10 | The user deletes or the lead edits the routine. `run` returns 404 | The bridge watches `state.routines` in the snapshot and on reconnect, and alerts the owner in Toy Box and Slack |
| R11 | The Toy Box CLI binds `0.0.0.0` | Document `--host 127.0.0.1`. The bridge could warn on startup if Toy Box answers on a non-loopback interface (inference) |
| R12 | Each wake costs a paid turn and there's no server-side budget | A bridge-side rate limit per channel and per hour, configurable, with a visible counter in its status |

## Appendix A: Where things are

- Channel prompts: `src/features/channels/server/agent.ts#buildChannelAgentInstructions`
- Tools and their descriptions: `src/features/channels/server/tools.ts`
- Wake prompts: `src/features/sessions/model/systemMessages.ts#systemMessagePrompt`
- Wake delivery: `src/features/channels/server/index.ts#wakeChannelAgent`,
  `src/features/sessions/server/runtime/sessionStream.ts#deliver`
- Scheduler: `src/features/channels/server/startup.ts`, `database.ts#claimDueWakes`
- Audience: `src/features/channels/model/index.ts#resolveChannelAudience`
- HTTP: `src/features/channels/server/api.ts`. SSE: `server/stream.ts`, `server/events.ts`,
  `src/shared/server/sse.ts`
- Data root: `src/server/database.ts`, `src/features/sessions/server/bundledSkills.ts`
- Provider configuration: `src/features/providers/server/{copilot/provider.ts, claude/connection.ts, codex/provider.ts}`

## 7. Review of the architecture brief (lead's message 20)

I reviewed `toy-box-slack-architecture.brief` against §1–6. Each finding names the brief section or
record and gives a concrete fix. Findings are ordered by severity.

### B1 (high). The owner gate and the operator role don't stop a steered lead. `cli`, `trust`, `fx-injected-setup`, `fx-wrong-caller`
- **Owner presence can be forged (fact).** The bridge counts an SSE `message` with
  `sender.type === "user"` as the owner speaking. But any local process, including a lead with an
  unrestricted shell, can `curl -X POST /api/v1/channels/<id>/messages` and produce exactly that
  event. `postChannelMessage` hard-codes `sender: { type: "user" }` (`channels/server/index.ts:221`).
  So can any session's `post_channel_message` tool (`postChannelMessageFromSession`). The
  transcript can't distinguish the forgery from the owner either.
- **The operator role is just an empty env var (fact).** The `cli` exhibit says *"With no session
  in env the caller is the operator."* Any agent can run `env -u COPILOT_AGENT_SESSION_ID
  toy-box-slack …` and become the operator.
- **So the gate is a speed bump, not a boundary.** The brief's `trust` section already concedes
  "while the owner is active". In fact, the lead can manufacture that activity itself. The
  forgery leaves a visible fake user message, but nobody is watching for one.
- **Fix:** widening changes (`link`, `allow`, `resume`, `--requests all`, `--observe channel`,
  `--publish-channel`) become *pending* until the **owner's Slack identity** confirms them. The
  agent can't write to that channel. Options for @slack-expert to choose between:
  - an ephemeral Block Kit button to the owner, using interactivity over Socket Mode
  - an ✅ reaction by the owner on a bridge confirmation message in the linked channel (needs
    `reactions:read` and `reaction_added`)

  Keep the 30-minute Toy Box check as a cheap first filter. Narrowing changes (`pause`, `deny`,
  `unlink`) stay immediate. Also reword `trust` so it doesn't imply the operator role is
  privileged.
- **Resolved (Slack Expert, message 26):** use Approve/Reject buttons on a durable bot-authored
  control post. They arrive over Socket Mode interactivity, add no new scope, and need
  `settings.interactivity.is_enabled: true`. Only the pinned owner can approve, and there's no CLI
  approve bypass. The owner is pinned at first setup by human provisioning. **The residual limit is
  agreed:** this proves Slack-user intent to an *intact* bridge. A same-UID agent shell can still
  edit `bridge.db` or the bridge process. Only OS-level isolation would close that gap, for example
  running the bridge as a separate user. That's out of scope for v1, and `trust` should say so
  plainly.

### B2 (high). Every bridge wake erases the lead's waiting status and cancels its follow-up. `px-wake`, `px-routines`
- **Facts:** `wakeChannelAgent` calls `clearAgentStatus(agentId, "waiting")` after every delivery,
  including routine runs (`index.ts:592-599`). A follow-up's `wakeAt` lives *inside* that waiting
  status, and `claimDueWakes` only fires follow-ups from it (`database.ts:536+`).
- **Consequence:** suppose the lead finished with `waitingFor: "Bridge Engineer's s3",
  wakeAfterMinutes: 30` and a Slack request arrives. The bridge's wake clears that status, and
  **the 30-minute check-back never fires**. The overview also stops showing the wait. The brief's
  `f-wake-routine` ("acknowledges no request") is true, but it misses this side effect.
- **Fix:** add one sentence to the requests routine template and the skill: *"When you finish, if
  you were waiting on someone before this wake, call finish_agent_turn again with that waitingFor
  and wakeAfterMinutes."* The lead's private transcript holds its last `finish_agent_turn` call,
  so it can recover the values. Add an e2e assertion that a lead's waiting status survives a Slack
  wake. A Toy Box change that preserves waiting on routine wakes would be cleaner, but it's out of
  our scope.

### B3 (high). Claude and Codex leads can never reply. `choices` row 1, `cli` "Who's calling", `f-caller-env`
- **The problem:** the `choices` table claims "one CLI works for Copilot, Claude and Codex". But
  under the brief's own caller rules, a shell without `COPILOT_AGENT_SESSION_ID` is the operator,
  and the operator "may … never reply or publish".
- **Claude (inference):** Toy Box passes its session ID as Claude's native `sessionId`
  (`claude/connection.ts:42,51`). If Claude Code exposes that ID to Bash, it would equal the Toy
  Box ID. That's unverified.
- **Codex (fact):** the thread ID is minted by Codex (`codex/provider.ts:103-147`), so it never
  equals the Toy Box ID, and the public API can't map it back.
- **This machine:** neither `claude` nor `codex` is on `PATH`. The user's leads run on Copilot today.
- **Fix:** scope v1 explicitly to **Copilot-provider leads**. `link` should read
  `channels[].model.provider` from the catalog and refuse other providers with a clear message.
  Move R3 (Claude and Codex identity) to v2.

### B4 (medium). Reminders nag a lead that's legitimately waiting on the owner. `px-wake` `dueReminder`, `px-lifecycle`
- The routine prompt tells the lead to ask the owner in Toy Box before doing consequential work for
  a non-owner. While it waits, the request sits in `seen` or `in_progress`, and a reminder fires
  after 30 minutes or 2 hours. Each reminder also re-clears the waiting status (B2).
- **Fix:** add a `hold <r> --reason` verb, or a request attention `awaiting_owner`, that suppresses
  reminders. Release it automatically when the next user message arrives on the Toy Box stream,
  which is the same event that clears `channel.requestSequence` (`reducer.ts:100`). Then expire as
  usual. The skill should say to flag the question with `send_channel_message` and
  `request: true`, then `hold`.

### B5 (medium). Routine prompt wording. `px-routines`
- **Quoting.** Toy Box injects the prompt as `JSON.stringify(prompt)`
  (`systemMessages.ts#systemMessagePrompt`), so newlines arrive as literal `\n`. Write each template
  as one paragraph with no line breaks.
- **Accuracy.** The safety-net cron fires even when nothing is pending, so "Slack requests from #x
  are waiting" is sometimes false. Say "Check for Slack requests from #x." Toy Box already appends
  *"If nothing needs the channel's attention, finish quietly,"* which then reads correctly.
- **Wording in the requests template:**
  - Change "Post in Toy Box only when the owner must decide" to "…decide something, flag it with
    send_channel_message and request: true." Without the flag the sidebar won't show it (lead
    prompt §Communicate).
  - Add "Reply yourself even if a member did the work. Members can't reply." The CLI enforces that
    members are read-only.
  - Add "Slack questions don't need channel tasks. Add a task only for substantial work the owner
    asked for." The lead prompt says routine runs add tasks "only for concrete work the run
    uncovers", which could otherwise turn every question into a task.
  - Add the waiting-status sentence from B2.
- **Digest template.** "Never use @ mentions" also bans the lead's legitimate Toy Box mentions of
  members. Narrow it to "Never write a Slack person's name after @". The CLI already renders them as
  `{Name}`.

### B6 (medium). The steer-after-2-minutes rule is sound. A guard is missing. `fx-lead-busy`
- **This part is correct:** presence `working` means the session is running
  (`model/presence.ts#channelAgentPresence`). A routine run then steers into the active turn, and
  identical queued routine prompts coalesce (`channel_routine:${prompt}`).
- **Missing:** the 2-minute fallback steers even when the running turn *is* the bridge's own wake
  that's already serving inbox. Add "and no inbox call since the oldest pending request changed" to
  the steer condition. Otherwise the bridge nudges a lead that's mid-inbox.

### B7 (medium). End-to-end harness details. `test-e2e`, plan step for e2e
- **The harness leaks its own identity.** A test run launched from an agent shell inherits *that
  agent's* `COPILOT_AGENT_SESSION_ID`. I observed it set in this shell. Operator calls from the
  harness then resolve as an unknown session and get refused. The harness must `env -u
  COPILOT_AGENT_SESSION_ID` for operator calls and for the spawned Toy Box server.
- **Provider auth under a temp `HOME` is unverified.** Copilot's user config and skills live in
  `~/.copilot`. Spike `HOME=$(mktemp -d)` with the built binary
  `toy-box/toy-box --port 3199 --host 127.0.0.1 --no-open` before s-e2e depends on it. That binary
  exists, built Oct 27. Also install the skill into the temp `HOME`'s `~/.copilot/skills`.
- **Skill freshness is unverified.** Copilot discovers skills when a session is created or resumed
  (`copilot/provider.ts:65-78`). A lead whose session predates `install-skill` may not see the
  skill until its next execution, or until a server restart. That's one more reason the routine
  prompts must stand alone (they do).

### B8 (low). Conventions. `conventions`, `repo`
- **An alias trap.** Toy Box gives each feature a tsconfig alias (`@channels/*`). An `@slack/*`
  alias for `src/features/slack` would **shadow `@slack/web-api` and `@slack/socket-mode`**. Name
  the feature differently (for example `slackapi`), or give it no alias.
- **Check script and hook.** Toy Box uses `"check": "bun fmt --check && bun lint && bun check"` and
  a pre-commit hook of `bun lint --staged --fix && bun fmt --staged`, not a full check. However,
  `bun lint` isn't recognized by either local Bun 1.4.4 binary ("Script not found"), so Toy Box's
  own script may depend on newer Bun. Use `oxlint` from `node_modules` and keep the same shape.
- **Fewer guides.** "Every feature has its own AGENTS.md" is more than Toy Box does. It writes
  guides per *subsystem* ("A guide's location marks the subsystem's semantic core"). Write guides
  for `requests`/`wakes` (the lead loop), `activity` (the ledger and repair), `outbox`, and
  `toybox`. Fold `links` and `commands` into the closest one.
- **Defaults.** `TOY_BOX_URL` defaults to `127.0.0.1:3000` (the CLI default), but this user runs
  Toy Box on **3100** via `vite dev`. `127.0.0.1:3100` answers even though it's bound to `::`
  (observed). The setup guide should say so, and `doctor` should probe `NITRO_PORT` when it's
  present.
- **Cron.** `cron-parser` ^5.10.2 matches `src/shared/cron.ts`. Schedules run in the Toy Box
  server's local time zone, so the bridge must use the same time zone when it derives publication
  periods.

### What I confirmed is right
- The routine-run seam: 204 means delivered (started or queued), 404 means the routine is gone,
  and 5xx means delivery threw (`api.ts#runChannelRoutineResponse`).
- Never posting into Toy Box.
- Debouncing and the budget.
- Detecting a deleted routine through `routine_deleted` and snapshots.
- Taking a replacement snapshot after Toy Box restarts.
- Caller resolution by catalog lookup. Refetch the catalog once on an unknown session ID before
  refusing, because members can join after the catalog loads.

## 8. Second review: the revised brief (lead's message 30)

**My findings landed.** All of these are in the revised brief:
- B1: owner approval in Slack, with the operator role framed as stopping mistakes rather than attacks.
- B2: `f-wake-clears-waiting`, with the restore hint in inbox and the routines.
- B3: Copilot only, with `blocked: provider`.
- B4: `hold`.
- B5: `f-routine-prompt` and the one-paragraph templates.
- B6: the `lastInboxAt` guard.
- B7: the harness unsets `COPILOT_AGENT_SESSION_ID`, and there's an s11 spike.
- B8: the `slackapi` name, subsystem guides, oxlint, and port 3100.

Here's what's still wrong or missing.

### C1 (medium). The waiting-status restore only covers bridge-initiated runs. `px-wake` trailing comment, `px-routines`
- **The gap.** `px-wake` says *"Before each run, record the lead's waiting status."* But Toy Box's own
  scheduler also runs routines, and every routine wake clears waiting (`wakeChannelAgent`). That
  includes the requests safety net (`0 9 * * 1-5`), the digest, and release notes. The bridge
  doesn't start those runs, so it records nothing.
- **The digest and release-notes templates promise something the CLI can't deliver.** They say *"if
  you were waiting on something before this run"*, yet `activity` and `publications` don't print
  the hint. Only `inbox` does in `px-inbox`.
- **Fix:** have the Toy Box client keep the **last waiting status it saw** for each lead from
  presence (`{state:"waiting", text, wakeAt?}`, `model/presence.ts`). When presence moves from
  `waiting` to `working`, whatever the cause, freeze that as "waiting before this turn". Every
  command's banner then carries the restore line until presence leaves `working`. That covers
  scheduler runs, catch-ups, and approval wakes too.
- **Wording.** Make it conditional: *"Before this turn you were waiting for X. If that's still true
  when you finish…"*. A user message may have legitimately resolved the wait in this same turn.
- **Validation.** `finish_agent_turn` rejects `wakeAfterMinutes` outside 5–120
  (`server/tools.ts#finishChannelAgentTurnParameters`). Print `ceil((wakeAt − now) / 60s)`
  clamped to [5, 120]. When the status had no `wakeAt`, which is normal when the lead waits on the
  user, **omit** `wakeAfterMinutes`. The `px-inbox` example always prints `wakeAfterMinutes 25`.
  Restoring a timeout when the lead was waiting on the user violates the lead prompt (*"Do not set
  a timeout while waiting on the user"*).

### C2 (low). `blocked: provider` can never clear. `px-wake`, outcome summary
- The lead's provider is immutable. `updateChannelFields` throws *"The lead's provider cannot change
  without losing its session history."* (`channels/server/database.ts:658-661`).
- "Until the lead is back on Copilot" therefore never happens. Refuse at `link`, which the brief
  already does. Keep the runtime branch as a defensive check, but word its status as permanent:
  "this channel's lead isn't on Copilot. Create a Copilot channel and link that instead."

### C3 (low). The inbox `--limit 10` interacts with the steer guard. `px-wake`, `px-cli`
- **How it happens:** say 12 requests are open and inbox serves 10. The other 2 stay `open` with
  `changedAt` older than `lastInboxAt`. While the lead works, the guard returns `wait lead_idle`,
  which is correct. But nothing tells the lead to run inbox again, so they wait until the turn ends.
- **Fix:** have inbox's footer say "2 more requests waiting. Run inbox again." The skill should
  mirror `read_channel`'s "Repeat while hasMore is true."

### C4 (medium). The s11 spike needs concrete auth and timing knobs. `s11`, `test-e2e`
- **Auth (fact, `copilot help environment`).** `COPILOT_HOME` defaults to `$HOME/.copilot`.
  `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN`, in that order, *"take precedence over
  previously stored credentials."* Bun's `os.homedir()` follows `$HOME` (verified:
  `HOME=/tmp/hx bun -e …` prints `/tmp/hx`). So under a temp `HOME`, Copilot has no stored login.
  The spike should test two approaches:
  - (a) the macOS keychain login, which may not depend on `$HOME`. This is unverified.
  - (b) `COPILOT_GITHUB_TOKEN` passed only through the harness's environment. Never write it to a file.

  Record which one works in `tests/AGENTS.md`. Isolation is a side benefit: the user's real
  `~/.copilot/session-state` stays untouched.
- **PATH.** The spawned Toy Box must inherit a `PATH` that includes the `toy-box-slack` under test.
  The agent's shell `PATH` comes from the server environment (`copilot/client.ts:28`).
- **Timers.** "Gets a reminder after answering in Toy Box" waits 30 minutes under `dueReminder`.
  The e2e suite needs the bridge's policy durations injected through config, for example
  `reminderSeenMs`, the debounce window, and the backoff. Otherwise s11 takes about an hour. Don't
  rely on Toy Box's routine cron in e2e, because it runs at most hourly with a fixed minute. Drive
  wakes through `routines/:id/run` only.
- **Nondeterminism.** A real model may phrase things differently or take an extra turn. Assert
  durable outcomes in the bridge database and the fake Slack, not text. Poll with a deadline.
  Cap retries at one rerun per scenario, and log the lead's transcript path on failure.
- **The waiting-status scenario needs a setup step.** The lead has to be in `waiting` with a
  `wakeAt` before the Slack wake. The harness can tell it as the owner: "wait for the bridge engineer
  and check back in 30 minutes". That's model-dependent. Assert on presence after the turn rather
  than on the lead's words.

### On field-by-field approval staleness (the lead asked for pushback)
- **I agree with field-by-field.** A global revision would void a pending `allow U` whenever an
  unrelated `deny V` or `pause` lands, which trains the owner to click through re-proposals.
- **Two refinements:**
  1. Every card should carry an *implicit* "before": that the same link is still active and the same
     owner is pinned. An ownership handoff (`owner <U>`) must void every pending card.
  2. Invariants that come from outside the config must be re-checked **at apply time**, not
     compared with the card. That covers the channel audience (private, shared, pending share), the
     link not being suspended, the Copilot provider, and the requests routine existing. A card that
     was valid when posted can't widen a link whose channel has since become shared.

## 9. End-to-end isolation spike (lead, 2026-10-28)

Run against the built binary `toy-box/toy-box` (Oct 27) on `127.0.0.1:3199` with `HOME` set to a fresh
temporary folder. This settles the open auth question in B7 and C4.

- **Agent shells leak `BUN_BE_BUN`, `NITRO_HOST` and `NITRO_PORT`.** With `BUN_BE_BUN` set, the compiled
  binary behaves as plain Bun: `--help` prints Bun's help and `--host 127.0.0.1` fails with
  *"File not found"*. The harness must unset all three, as well as `COPILOT_AGENT_SESSION_ID`.
- **Stored login doesn't carry over.** Under the temporary `HOME`, `GET /api/v1/models` returned an empty
  list and the server logged *"models.list failed with message: Not authenticated"*. The macOS keychain
  login didn't help.
- **`COPILOT_GITHUB_TOKEN` in the server's environment works.** Passing `gh auth token` output only
  through the environment, never a file, listed every Copilot model.
- **A lead ran in isolation.** `POST /api/v1/channels` created the channel, but I saw no kickoff post.
  The code does start a kickoff turn, so it probably failed quietly (see the analyst's note below).
  The first user message started a turn that worked. With a skill written to the temporary
  `~/.copilot/skills` before the channel existed, a `claude-sonnet-5` lead answered with the skill's
  secret word and its shell's `COPILOT_AGENT_SESSION_ID`, which equaled the channel ID.
- **A small model wasn't reliable.** A `claude-haiku-4.5` lead ran twice and both times called a channel
  tool without its `content`, so it never posted. End-to-end tests should pin a stronger model.
- **`GET /api/v1/channels/:id/messages` needs `?before=`.** Without it the server answers
  *"Invalid Channel request."*
- **A lead's shell has no terminal.** In this channel's own Copilot lead, `test -t 0` and `test -t 1`
  both fail, so a command that insists on an interactive terminal can't be run by the lead by mistake.
  A process that wants one can still fake it, for example with `script`.

**Analyst note on §9 (code contradicts one observation).** `createChannel` spawns the lead with the
first message *"This channel was just created. Begin working toward its purpose."*
(`channels/server/index.ts:140-157`). `superviseAdmittedWorker` passes it straight to `createSession`
(`workers/server/supervisor.ts:88-99`), so channel creation **does** start a turn.

If no turn appeared in the spike, my best guess is that the first execution failed and was recorded
as a failed completion with no post. That could happen if the channel was created before auth
worked, or if the failure only shows in the server log. This is unverified.

For e2e this matters:
- **Wait for the kickoff turn.** After `POST /api/v1/channels`, wait for the lead's presence to
  leave `working` before driving the scenario. Otherwise the first Slack wake steers into the
  kickoff.
- **Keep the kickoff cheap and bounded.** A channel with a purpose makes the lead frame the work,
  post a kickoff, and possibly create tasks or members (lead prompt, "Frame and kick off"). Give the
  e2e channel a narrow purpose. For example: "Answer Slack requests from the linked channel through
  toy-box-slack. This is a test channel: do not create members or tasks."
- **Assert the kickoff succeeded.** Check that the lead posted its kickoff, so an auth failure
  surfaces as an error instead of a silent no-op.

## 10. Held wakes while a background agent runs (t67, 2026-10-30)

Sources:
- Toy Box `8cafc93`, running as `./toy-box --port 3100`, built at 20:29 on Oct 29.
- Copilot CLI 1.0.105 and `@github/copilot-sdk` 1.0.27.
- The lead's `events.jsonl`.
- The bridge's `apps/toy-box-dev/bridge.db` (`wakes`), read-only.

### What happened

None of the three wakes was lost. **The Copilot CLI held them in its own queued lane** until the
send that was open at the time closed. It then delivered them in FIFO order, one per send close:

| Wake | Sent | Delivered (`user.message`) | Native `delivery` |
|---|---|---|---|
| Routine run 1 | 04:33:43.79 | 04:51:55.513 (line 79367) | `queued` |
| Owner seq 756 | 04:35:58.47 | 04:53:56.793 (line 79441) | `queued` |
| Routine run 2 (retry) | 04:36:43.80 | 04:54:47.243 (line 79498) | `queued` |

### It was the CLI's queue, not Toy Box's

- **Toy Box handed each wake to the CLI straight away.** Every channel wake is
  `deliverSessionMessage(…, { immediate: true })` (`channels/server/index.ts#wakeChannelAgent`).
  `SessionStream.deliver` sends an immediate message straight to the provider unless another one is
  mid-submit (`sessions/server/runtime/sessionStream.ts:157-166`).
- **The Copilot adapter passes `mode: "immediate"` to `native.send`**
  (`providers/server/copilot/connection.ts:67-86`). The SDK's `send` resolves as soon as
  `session.send` returns a messageId (`copilot-sdk/dist/session.js#sendMessage`). That's why the
  bridge's runs got their 2xx in milliseconds.
- **Toy Box's own queue couldn't have held them.**
  - It would have merged the two identical routine prompts (`systemMessageCoalesceKey` is
    `channel_routine:${prompt}`, `sessions/model/systemMessages.ts`). They weren't merged.
  - In `background` status it drains on every provider event (`sessionStream.ts:394`), and
    subagent events streamed the whole time.
  - It drains only on `session.idle` while running. Yet seq 756 landed 47 ms after a turn end inside
    one CLI interaction, with no idle between them.
- **`delivery: "queued"` is the CLI's own lane label.** The others are `steering` (an interjection
  into a live turn) and `idle` (a send that starts a new turn).

### Why routine run 1 wasn't steered at 04:33:43.79 (inference from SDK schema docs, not native code)

- **Steering only lands between model steps.** Turn 35's model request was already in flight
  (04:33:40.61 to 04:33:44.51) and ended with text and no tool call, so there was no next step to
  interject into. `SessionQueueSnapshot.steeringMessages` describes these as *"Immediate steering
  messages waiting for an active turn"*. `MessageOptions.responseSchema` says immediate steering
  is *"promoted to a follow-up after the model request finishes"*.
- **Contrast:** seq 754's wake at 04:26:48.564 arrived while tool calls kept turn 4 going, and it
  steered in (`delivery: "steering"`, line 77931).

### Why it waited until 04:51:55 and missed the 04:40:23 turn (inference, same basis)

- **The queued lane waits for background work.** The SDK exposes a native "deferred-idle drain"
  keyed on `activeBackgroundWork` (`QueueBeginDeferredIdleDrainRequest`,
  `QueueFinishDeferredIdleDrainResult.action`: `none | processQueue | emitSessionIdle`). The
  background subagent ran until 04:40:23.
- **The 04:40:23 turn wasn't a drain.** It was the CLI consuming its own `agent_idle`
  `system.notification`, and it stayed in the same send (`originatingMessageId` 6d6421e6). The
  queued lane drained only when that send closed at 04:51:55.47.
- **System wakes are invisible in `pendingItems`.** Toy Box sends wakes with `source: "system"`,
  and `queue.pendingItems` *"omits internal system items"*. Only the internal `queue.snapshot`
  shows them.

### Why routine run 2 and seq 756 queued too

- **They arrived with no live main turn and a non-empty queued lane**, so they went in behind run
  1. The native queue doesn't coalesce, so the bridge's retry became a duplicate turn at 04:54:47.
- **An empty lane behaves differently.** Earlier immediate wakes during the same subagent
  (04:15:37, 04:22:19, 04:25:11, 04:26:09) each started a turn at once with `delivery: "idle"`.
- **The trigger** is one wake that lands during a turn's last model request while a background
  agent is still running. Every later wake queues behind it until that background work and the
  CLI's follow-up turn finish.

### What presence and the API showed

- **The session went to `background`.** At 04:33:44.5 root `assistant.idle` projected
  `{status: "background"}` (`copilot/projector.ts:196-197`), and Toy Box set the session to
  `background` (`workspace/server/state/index.ts:68-77`, which emits `session.background`).
- **Channel presence counts only `running` as working** (`channels/server/stream.ts:161`,
  `server/tools.ts:473`, `server/api.ts:41`). The lead's waiting status, set at 04:33:40.6, was
  cleared 3 s later by run 1 (`wakeChannelAgent`). So from 04:33:44.5 to 04:40:23, channel presence
  and the catalog's `working` list both showed the lead as **idle**.
- **`GET /api/workspace` (SSE) is the only loopback signal of the real state.** It emits
  `session.running`, `session.background` and `session.idle` with the lead's session ID
  (`workspace/model/events.ts:29`). It's at most once, with no replay. No public API exposes either
  queue.

### Fixes

- **Toy Box (smallest, needs a spike).** In `connectCopilotSession`, track sent messages whose
  `user.message` echo hasn't arrived (`pendingInputs` already maps messageId to clientId). On a root
  `assistant.idle`, withdraw each with
  `native.rpc.queue.withdrawMessage({ messageId, expectedPrompt })`. If `removed`, send it again.
  With no live turn and an empty lane, that starts a turn at once, like the `idle` deliveries above.
  - Unverified: whether `withdrawMessage` accepts `source: "system"` messages.
  - Report the CLI behavior upstream either way. A promoted steering message shouldn't wait on
    background work when the main loop is idle.
- **Bridge, meanwhile.**
  - A 2xx run means "the CLI has it", not "it landed". Its retries are duplicates, not recoveries.
  - Follow `/api/workspace` for the lead's session.
  - Retry only when the lead's session reaches `session.idle` (or `unread`) after the wake with no
    inbox call since. That's the point where a wake is truly lost.
  - Never retry while the session is `running` or `background`. Re-subscribe and treat the state as
    unknown after reconnecting.
- **Lead behavior.** Don't finish a turn while a background subagent is still running, or use a
  synchronous task or a member instead. Otherwise every wake can wait out that subagent.
