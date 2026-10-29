# Slack integration research

Evidence checked: 2026-10-28. This document distinguishes Slack's published
contract from recommendations and items that need a live workspace to verify.
Early research used no credentials. Later live probes are attributed explicitly.

## Reduced v1, approved October 28

The current scope is terminal setup protected by a bridge-checked owner passphrase,
one watched channel per Toy Box channel, allowlisted requests, threaded answers,
publications in that same Slack channel and fire-and-forget eyes. There are no
approval cards, interaction payloads, file ingestion, native status, progress edits
or generalized cleanup operations. The later sections preserve research into those
retired designs, not requirements to bring them back.

Unknown posts get positive-only metadata checks around one and five minutes.
Neither misses nor retraction release a request or publication slot. Publications
use their routine's scheduled slot, not the date when a delayed run happens.
Secret-shaped output is refused both at rendering and at the send boundary.
Method cooldowns are shared by the bridge's one Slack client in memory. Restart
may encounter another 429, but never releases an ambiguous post's reservation.

Catch-up records gaps on reconnect, throttled delivery and unreadable events.
It scans 30 days of roots and follows threads with recent replies, merging
new or edited versions through normal ingest. History is not a deletion log.
Catch-up misses replies on older roots and edits to replies in threads it
does not revisit. Unfinished reads are retried and reported, without holding posts.
Fresh channel-audience reads happen at link, resume and before every post,
not at startup or before catch-up.

The startup and hourly cleanup keeps Slack text, the bridge's own posts
included, for at most 30 days after it last changed. Only a post that may still
go out keeps its text longer. Rows that outlast their text keep only the
identifiers, timestamps, states and hashes that posting once and numbering need.

### Smaller v1: live Markdown probe

On 2026-10-28, Slack Expert posted one `markdown` block in the approved
private test channel, read it back and deleted it. A heading became a
header block. A list, fenced TypeScript and an HTTPS link became the corresponding
rich-text elements. The initial escaped probe made `<!here>`, `@channel` and a
bot-user `<@ID>` sample ordinary text elements, with no user or broadcast elements.

Later owner probes that day showed that broad entity escaping breaks code:
Slack displays `Array&lt;string&gt;` and `a &amp;&amp; b` literally inside code.
The reduced renderer therefore escapes `<` only before `@` or `!`, retains the
zero-width break in plain broadcast words, and preserves other Markdown bytes.
Control openers inside code are escaped too, an accepted limitation.

A follow-up through the actual `renderMarkdown` and payload check in the
test channel preserved inline `Array<string>`, `a && b`, fenced comparisons
and a real blockquote. Raw bot-user and `<!date^...>` controls, and their numeric
entity forms, came back only as text nodes, with no user, date or broadcast
elements. The post was read back and deleted. These probes verify translation
of these payloads, not a person's notification settings.
Slack documents the block's combined 12,000-character limit and translation:
[Markdown block](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/).

## Recommendations that affect the architecture

1. Use a local, outbound-only Socket Mode bridge. Never expose Toy Box or proxy
   its unauthenticated API to Slack. Start with `@slack/socket-mode` plus
   `@slack/web-api`, not a custom WebSocket implementation.
2. Commit event effects before acknowledging them. Keep transport acknowledgement,
   ledger storage, agent consumption and external posting distinct. An ack
   does not mean the lead has read or answered a message.
3. Keep channel history and thread recovery separate. A high-water timestamp for
   channel roots cannot prove that replies to old roots have been recovered.
4. Authorize requests in deterministic bridge code using installation,
   channel, and immutable Slack user IDs. Monitoring content is not permission
   to execute its instructions. Recheck authorization when posting.
5. Reply in the original thread, using one clearly identified Toy Box app.
   Do not mirror the internal agent transcript or use customized identities by
   default.
6. Treat Slack sends as non-idempotent, with an ambiguous-outcome state. There is
   no verified public exactly-once contract for `chat.postMessage`.
7. Prefer a local durable schedule that wakes the lead, then posts its newly
   generated release notes. Slack's scheduled-message API schedules an already
   composed message, not future reasoning.

Socket Mode and message delivery contracts:
[Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/),
[Events API](https://docs.slack.dev/apis/events-api/),
[history](https://docs.slack.dev/reference/methods/conversations.history/),
[replies](https://docs.slack.dev/reference/methods/conversations.replies/),
[posting](https://docs.slack.dev/reference/methods/chat.postMessage/).

## App manifest, adopted v1

This is the manifest for public and private channel monitoring, threaded answers,
periodic publications and request eyes. The canonical installable file is
[`../manifest.yaml`](../manifest.yaml).
V1 omits outbound uploads, DMs, agent-container features, impersonation,
workspace administration, automatic channel joining, and Slack-side configuration
commands. All message monitoring already exposes mentions, so a separate
`app_mention` subscription is unnecessary.

```yaml
_metadata:
  major_version: 1
display_information:
  name: Toy Box
  description: Channel monitoring and threaded answers from your local Toy Box lead
  background_color: "#4a154b"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: false
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: toy-box
    always_online: false
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - users:read
      - chat:write
      - metadata.message:read
      - reactions:write
settings:
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - member_left_channel
      - channel_archive
      - channel_deleted
      - group_deleted
      - app_uninstalled
      - tokens_revoked
      - channel_shared
      - channel_id_changed
```

| Scope | Why it is present |
| --- | --- |
| `channels:history` | Receive public-channel messages and recover accessible history and threads. |
| `channels:read` | Resolve/validate channel IDs and detect sharing or ID changes. |
| `groups:history` | Equivalent message/history access for private channels the app has joined. |
| `groups:read` | Resolve/validate those private channels and their privacy/sharing flags. |
| `users:read` | Resolve explicit allowlist selections and check bot/deactivated/external user attributes without collecting email. |
| `chat:write` | Post threaded answers and publications, and delete one known app post. |
| `metadata.message:read` | Read correlation metadata when reconciling an uncertain outbound post. |
| `reactions:write` | Fire-and-forget eyes when the lead picks up a request. |

Create a separate **app-level token** with `connections:write` under Basic
Information. It is not a bot scope and does not go in `oauth_config.scopes.bot`.
Install the app to obtain a bot token, invite it explicitly to each monitored
channel, and store both tokens outside the repository. No request URL, public
tunnel, user token, signing secret, or OAuth redirect server is needed for this
single-workspace, manually installed Socket Mode setup.

Adding scopes later requires reinstalling the app. Manifest syntax is based on
the published schema, but server-side validation in Slack's app settings remains
necessary because no configuration token exists here.

Sources:
[manifest schema](https://docs.slack.dev/reference/app-manifest/),
[manifest setup and reinstall behavior](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/),
[scope catalog](https://docs.slack.dev/reference/scopes/),
[Socket Mode setup](https://docs.slack.dev/apis/events-api/using-socket-mode/),
[uninstall event](https://docs.slack.dev/reference/events/app_uninstalled/),
[revocation event](https://docs.slack.dev/reference/events/tokens_revoked/),
[Slack Connect](https://docs.slack.dev/apis/slack-connect/),
[files](https://docs.slack.dev/messaging/working-with-files/).

## Important current-platform qualifications

The May 29, 2025 announcement now explicitly exempts internal customer-built apps.
It limits affected new commercially distributed, non-Marketplace apps/installations
to one request per minute and 15 objects per request for both history and replies.
Its current wording says existing installations are not impacted. Do not copy
older claims about a universal March 3, 2026 deadline into our setup guide.
Treat this test app as internal only while that is factually true. Slack explicitly
includes templated custom apps connecting to a commercial product in its commercial
distribution guidance.
[Current dated announcement and FAQ](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/).

The current `conversations.replies` method page lists bot scopes for public and
private channels and no longer states the historical DM/MPIM-only bot restriction.
That is published documentation, not a live test. Probe a public and a private
thread during setup and expose unsupported/missing-scope failures rather than
silently claiming complete thread recovery. Do not request a broad user token
preemptively.
[Current method reference](https://docs.slack.dev/reference/methods/conversations.replies/).

## V1 decisions settled for app creation

**No agent container or streaming in v1. Channel-thread status needs fresh
live qualification.** On March 5, 2026 Slack enabled `assistant.threads.setStatus`
with `chat:write`. Its method reference still describes a custom text indicator
that clears on reply or after two minutes, at a default 600 calls/minute/app/workspace.
[Scope change](https://docs.slack.dev/changelog/2026/03/05/set-status-scope-update/),
[method contract](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/).

**Compatibility caveat, verified October 28, 2026.** The current migration guide
says Slack bridges non-empty legacy status to session `processing`, and empty
status to `active`. It plans deprecation of the legacy methods. The sessions guide
says only declared agent apps create sessions, that processing shows "Working..."
without custom loading text, and that it lasts up to an hour without an explicit
transition. A normal reply does not end a native session's processing.
The new method is Tier 3 (50+/minute), not the legacy default 600/minute.
[Compatibility bridge](https://docs.slack.dev/ai/migrating-to-agent-messaging/#compatibility-bridge),
[session contract](https://docs.slack.dev/ai/agent-sessions/),
[new method and limits](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/).

The visible behavior of either call in a regular channel with no `agent_view`
declaration remains **unverified**. No live call was made under the standing
credential/live-test restriction. A protocol fake cannot prove custom text,
manifest eligibility, residual titles or session visibility after clearing.
A permitted probe should compare fresh threads with both methods, record what
another channel member sees before and after clearing, and record exact refusals.
Do not toggle `agent_view` on the existing app merely to probe it: Slack documents
that migration as irreversible.
[Migration constraints](https://docs.slack.dev/ai/migrating-to-agent-messaging/).

`chat.startStream` currently lists only `chat:write`. Channel streaming requires
the root `thread_ts`, `recipient_user_id`, and `recipient_team_id`. However, the
method also lists `messages_tab_disabled`, and we have not live-tested streaming
with a disabled app Messages tab and no agent declaration. More importantly,
streams end after 10 minutes, do not extend on append, and are a poor fit for a
lead doing open-ended research or code work. V1 should use complete answers plus
a small number of edited progress messages. No extra AI scope is needed for
that UX.
[Streaming method and limits](https://docs.slack.dev/reference/methods/chat.startStream/),
[Slack's long-running-task recommendation](https://docs.slack.dev/ai/developing-agents/#respond).

**Disable the app Messages tab.** The manifest does so explicitly. No `message.im`
subscription or DM scopes are requested. Explain in the app description/setup
that requests belong in configured channels. Hiding this entry point is not a
security control and should not be advertised as preventing every possible DM
route in every Slack client.
[Manifest app-home fields](https://docs.slack.dev/reference/app-manifest/#features).

**Subscribe to lifecycle signals, but also reconcile channel metadata.** The
manifest includes public archive, public/private delete and rename, membership,
sharing, and ID-change events. Compare `member_left_channel.user` with the bot's
authenticated user ID to suspend a binding immediately. Public-to-private
conversion arrives as a `message` subtype already covered by message
subscriptions. Refresh `conversations.info` when any lifecycle signal arrives,
on reconnect, periodically for configured channels, and before sends when the
cached privacy/sharing information is stale. Never bind automatically because
someone invited the app. Acknowledge and drop content from unconfigured channels
before writing it to disk, queues, logs, or model context.

Do not add `group_archive` or `channel_unarchive` to an Events API manifest on
the strength of their names: their current reference pages mark them RTM-only.
Private archive/unarchive detection therefore must not depend solely on those
events. Check authoritative `is_archived`, membership/privacy flags, and API
failures. A rename changes display metadata, not our authorization key.
[Membership](https://docs.slack.dev/reference/events/member_left_channel/),
[join](https://docs.slack.dev/reference/events/member_joined_channel/),
[public archive](https://docs.slack.dev/reference/events/channel_archive/),
[public delete](https://docs.slack.dev/reference/events/channel_deleted/),
[private delete](https://docs.slack.dev/reference/events/group_deleted/),
[public rename](https://docs.slack.dev/reference/events/channel_rename/),
[private rename](https://docs.slack.dev/reference/events/group_rename/),
[private archive limitation](https://docs.slack.dev/reference/events/group_archive/),
[unarchive limitation](https://docs.slack.dev/reference/events/channel_unarchive/),
[conversion subtype](https://docs.slack.dev/reference/events/message/channel_convert_to_private/),
[channel info](https://docs.slack.dev/reference/methods/conversations.info/).

**Attach outbox correlation metadata.** Post with:

```json
{
  "metadata": {
    "event_type": "toy_box_outbox",
    "event_payload": {
      "outbox_id": "opaque-random-id",
      "payload_hash": "hash-of-approved-public-content"
    }
  }
}
```

No schema registration or org-wide deployment is needed for a custom event type.
Do not add a top-level manifest `events` schema: current Slack docs say that
requires org-wide deployment, which this local app does not need.
Read message metadata using `include_all_metadata=true` on history or replies.
The history/replies method pages do not list a separate metadata scope, while
the metadata scope explicitly covers metadata-event subscriptions. The v1
manifest nevertheless includes the correctly named `metadata.message:read`
scope for the intentional metadata-reading capability, avoiding a reinstall if
workspace/token filtering requires it. We do not subscribe to other apps'
metadata events or request wildcard metadata subscriptions.
[Sending/receiving metadata](https://docs.slack.dev/messaging/message-metadata/),
[metadata scope](https://docs.slack.dev/reference/scopes/metadata.message.read/),
[history argument](https://docs.slack.dev/reference/methods/conversations.history/),
[replies argument](https://docs.slack.dev/reference/methods/conversations.replies/).

After an uncertain send, scan the known target thread, or a bounded channel time
range for a root post, paginating completely. Match both our actual app/bot
identity and the exact outbox ID/hash. One matching message proves that post was
accepted and lets us recover its `ts`. No match does **not** prove non-delivery:
the message might not yet be visible, metadata might have been rejected, access
may have changed, or a human may have deleted the post. Retry bounded reads,
then expose `delivery_unknown` for operator resolution rather than blindly
resending. This greatly improves recovery but is not an exactly-once primitive.
Metadata is accessible to others in the workspace, so never put credentials,
private paths, internal prompts, or sensitive Toy Box context in it.
[Metadata visibility](https://docs.slack.dev/reference/methods/chat.postMessage/#arguments).

## 1. Connection and runtime

### Wire protocol and lifetime

Call `apps.connections.open` with an app-level token in the Authorization
header, connect to its temporary WebSocket URL, and wait for `hello`. The
app-level token opens connections, while the bot token performs workspace Web
API operations. Never log the connection URL because its ticket is sensitive.
Socket Mode needs no inbound request URL and its established connection is
pre-authenticated, so individual payloads do not need HTTP signature checking.
That authenticates Slack delivery, not the authority of the author of a message.
[Socket Mode protocol](https://docs.slack.dev/apis/events-api/using-socket-mode/),
[connection method](https://docs.slack.dev/reference/methods/apps.connections.open/).

Slack currently does not permit Socket Mode apps in the public Marketplace.
This is suitable for the local internal install. Any future Marketplace strategy
must revisit the transport without exposing unauthenticated Toy Box. A
commercially distributed unlisted Socket Mode app can still fall into the
restricted history/replies rate-limit category.
[Distribution restriction](https://docs.slack.dev/apis/events-api/using-socket-mode/#creating),
[commercial rate-limit classification](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/).

An application payload arrives as an envelope:

```json
{
  "type": "events_api",
  "envelope_id": "unique-delivery-envelope",
  "accepts_response_payload": false,
  "payload": {
    "type": "event_callback",
    "team_id": "T...",
    "api_app_id": "A...",
    "event_id": "Ev...",
    "event": { "type": "message", "channel": "C...", "ts": "123.000001" }
  }
}
```

Send `{"envelope_id":"unique-delivery-envelope"}` to acknowledge receipt. The
envelope ID acknowledges a delivery, while the Events API `event_id` identifies
the underlying event. A retry or another connection must not create another
logical request. Keep retry metadata for diagnosis, not authorization.
`accepts_response_payload` is not a general way to post an answer to a channel.
[Envelope and ack](https://docs.slack.dev/apis/events-api/using-socket-mode/#events),
[event identity](https://docs.slack.dev/apis/events-api/#callback-field).

**Recommended handler boundary:** validate the envelope and configured
installation/channel, insert an approved minimal payload into a transactional
inbox with a uniqueness constraint, commit, and ack. On a duplicate, ack without
re-enqueueing. On storage failure, report unhealthy and do not send a success ack.
Do not fetch history/files or wait for an agent in this path. Set a conservative
three-second ack budget and measure p99 with a stricter local target such as
250 ms. Slack explicitly documents three seconds for HTTP Events API responses.
The Socket Mode guide requires acks but does not publish an equally detailed
retry timetable, so do not import HTTP's nearly-immediate/one-minute/five-minute
retry sequence as a Socket Mode guarantee.
[HTTP retry contract](https://docs.slack.dev/apis/events-api/#retries).

Route installation-level control events separately from channel messages.
Uninstall/revocation/rate-limit events have no message channel. A `file_deleted`
event has a file ID but no channel and should affect only our existing
configured-file index. Do not solve "drop unconfigured messages" by discarding
every payload that lacks `event.channel`.

Connections refresh every few hours. Handle `disconnect` reasons including
`warning`, `refresh_requested`, and `link_disabled`, plus unexpected network
close, absent heartbeat, machine sleep, proxy resets, and DNS/TLS failures.
Request a fresh URL on reconnect. A warning may precede disconnect by roughly
ten seconds but is not guaranteed. Slack permits up to ten concurrent
connections and distributes each payload to any of them without an ordering
promise. Prefer one bridge owner with a process/database lease. A second socket
can ease planned rotation, but multiple sockets are not replay or extra API
quota. Mark every disconnected interval as a potential recovery gap.
[Lifecycle and connections](https://docs.slack.dev/apis/events-api/using-socket-mode/#connections).

### Library choice

| Option | Assessment |
| --- | --- |
| `@slack/socket-mode` + `@slack/web-api` | Recommended starting point. Explicit ack control, SDK reconnection/heartbeat, typed Web API, small integration surface. The control-payload gap below is a production gate. |
| Bolt | Prefer if we add substantial Slack interactivity, OAuth installation, or agent-container handlers. It adds receiver/middleware behavior that must be audited for ack-before-persistence and is unnecessary for a channel-monitoring worker. |
| Custom Socket Mode client | Avoid by default. It owns heartbeat frames, ticket refresh, reconnect races, shutdown and protocol evolution. A targeted receiver adapter is preferable to replacing all transport behavior. |

Bolt's receiver passes retry metadata and an ack into `App.processEvent`, and
its built-in `autoAcknowledge` middleware acks before calling the next listener.
Do not assume placing a database write inside a high-level event listener gives
ack-after-commit durability.
[Bolt receiver, pinned release source](https://github.com/slackapi/bolt-js/blob/ffbe0b6c03a6b1e16b3d5d3c5c9a8ab3effcbc1d/src/receivers/SocketModeReceiver.ts),
[Bolt auto-ack middleware](https://github.com/slackapi/bolt-js/blob/ffbe0b6c03a6b1e16b3d5d3c5c9a8ab3effcbc1d/src/middleware/builtin.ts).

### Local SDK verification

The original eight-test SDK spike passed under **Bun 1.4.4** and **Node
24.19.0**. It was retired after the bridge gained its own protocol-fake suites;
uploads and the standalone spike package are not part of reduced v1.
The installed versions remain `@slack/socket-mode` 3.1.0 and `@slack/web-api`
8.2.0. Their current lifecycle and retry checks run from the repository root:

```sh
bun test tests/integration/slackSocket.test.ts tests/integration/slackBotClient.test.ts
bun test src/features/outbox/server/posts.test.ts
```

These suites exercise localhost HTTP and WebSocket connections with fake tokens,
including raw hello and rate-limit frames, explicit acknowledgements, close,
surfaced `Retry-After`, cursor continuation and a lost post response with SDK
retries disabled. The supervisor suite owns reconnection. These are not live
Slack TLS, proxy or Mac-sleep tests, nor an upstream Bun support promise.
The selected SDK release comes from upstream commit
`a98047a7f27149812664c78e2dccfe4155b0e145`.
[Socket SDK package](https://www.npmjs.com/package/@slack/socket-mode/v/3.1.0),
[Web API package](https://www.npmjs.com/package/@slack/web-api/v/8.2.0),
[pinned WebSocket implementation](https://github.com/slackapi/node-slack-sdk/blob/a98047a7f27149812664c78e2dccfe4155b0e145/packages/socket-mode/src/SlackWebSocket.ts).

**Reproduced SDK gap, not a passing production feature:** Slack documents
`app_rate_limited` as a top-level payload with no inner `event`. The SDK 3.1.0
`events_api` dispatcher dereferences `payload.event.type` unconditionally. Feeding
the documented top-level shape into that dispatcher rejects with `TypeError`,
which the retired spike recorded as a characterization test. Its async event-listener
boundary does not turn that into a normal `slack_event` callback. We have not
observed a real rate-limited Socket Mode delivery, so the precise production
wrapping remains a live verification item. The bridge now reads raw frames before
SDK dispatch, and `tests/integration/slackSocket.test.ts` pins the documented
top-level control shape. This avoids the dispatcher bug without a global
unhandled-rejection handler or a false "all events processed" health signal.
[Documented payload](https://docs.slack.dev/reference/events/app_rate_limited/),
[dispatcher source](https://github.com/slackapi/node-slack-sdk/blob/a98047a7f27149812664c78e2dccfe4155b0e145/packages/socket-mode/src/SocketModeClient.ts).

**Upstream corroboration:** this is already tracked in open
[issue 2753](https://github.com/slackapi/node-slack-sdk/issues/2753)
(October 1, 2026) and
[issue 2167](https://github.com/slackapi/node-slack-sdk/issues/2167).
An October 20, 2026
[report includes the rate-limit payload inside a real `events_api` delivery](https://github.com/slackapi/node-slack-sdk/issues/2167#issuecomment-6287990645)
and a
[follow-up confirms 3.1.0 is affected](https://github.com/slackapi/node-slack-sdk/issues/2167#issuecomment-6288019493).
That supports treating this as a real production failure, not merely a
hypothetical schema mismatch. It is still an external report rather than our own
live observation. No issue or comment was posted by this research.

## 2. Canonical messages, threads, and read cursors

### Identity and ordering

Slack's message `ts` is an opaque string ID unique within a conversation, not a
JavaScript number or Date. Store its exact bytes. If comparing time order, parse
decimal components into integers/BigInt or use a tested normalized decimal
comparator. Never round through floating point. Do not assume a `C` prefix means
public or a `G` prefix means private.
[Message identity](https://docs.slack.dev/messaging/retrieving-messages/#individual_messages),
[channel-type caveat](https://docs.slack.dev/apis/slack-connect/#same-channel).

Recommended primary key: `(installation_id, canonical_channel_id, message_ts)`.
Keep aliases for Slack-provided channel-ID migrations. Record the original
event wrapper, author ID, root `thread_ts`, edit/version time, subtype, source,
and tombstone state only for configured and permitted observations.
Keep a monotonically increasing **local change sequence** for newly discovered
messages, meaningful edits, and tombstones. This local sequence, not maximum
Slack `ts`, is the lead's consumption cursor.

Use the outer `event_id` to dedupe live deliveries per installation, and the
canonical message/version key to merge events with backfill. Do not assume
arrival order: a delete can arrive before a delayed create, and history repair
can race a newer edit. A tombstone must defeat an older create. Compare explicit
edit/event version evidence and avoid letting a stale snapshot resurrect a
deleted message. Changes only to reply counters, language detection, or other
irrelevant metadata must not become a fresh executable request.
[Events fields and extensibility](https://docs.slack.dev/apis/events-api/#event-type-structure),
[language-detection edit caveat](https://docs.slack.dev/reference/events/message/message_changed/).

### Normalization rules

| Incoming shape | Canonical handling |
| --- | --- |
| Plain `message` with no subtype | New human message, subject to identity and policy checks. Empty text can still accompany a file. |
| `thread_ts` absent | Root message, `root_ts = ts`. |
| `thread_ts === ts` | Thread root, not a reply. This field can remain after every reply is deleted. |
| `thread_ts !== ts` | Reply in that root's thread, even with no special subtype. |
| `message_replied` / parent bookkeeping | Refresh thread metadata. Do not execute the root's old text as another request. |
| `thread_broadcast` | A pointer/reference to a reply. Merge by channel+reply `ts`, hydrate real thread content when necessary, and never count both deliveries as separate questions. |
| `message_changed` | Use nested `message.ts` as identity and nested content as the new version. Outer `ts` is not the edited message ID. |
| `message_deleted` | Tombstone `deleted_ts`. Do not execute or re-import original text. |
| `bot_message`, `bot_id`, `app_id`, self user | Ignore as executable requests. Other bots may be monitored as explicitly untrusted context only if enabled. |
| `file_share` / `files` | Preserve file IDs and message context. Fetch authorized files asynchronously with bounds. |
| Join/leave/topic/purpose/name/archive/privacy notices | Lifecycle metadata, not agent instructions. |
| Unknown subtype / redaction / EKM denial | Preserve a minimal typed diagnostic if in scope. Do not assume it is a human request or substitute invented text. |

Sources:
[message catalog](https://docs.slack.dev/reference/events/message/),
[thread detection and retrieval](https://docs.slack.dev/messaging/retrieving-messages/#finding_threads),
[message_replied caveat](https://docs.slack.dev/reference/events/message/message_replied/),
[broadcast](https://docs.slack.dev/reference/events/message/thread_broadcast/),
[edit](https://docs.slack.dev/reference/events/message/message_changed/),
[delete](https://docs.slack.dev/reference/events/message/message_deleted/).

### Four checkpoints, not one

| Checkpoint | Meaning |
| --- | --- |
| Durable event inbox | Slack delivery is safe to ack. It says nothing about agent processing. |
| Recovery coverage | A specified channel/time range or thread has been enumerated to a known boundary. Root coverage is not thread coverage. |
| Per-binding agent cursor | The lead has explicitly consumed/classified local change records through a contiguous sequence. |
| Outbound ledger | A particular approved response/publication is pending, sent, failed, cancelled, or delivery-unknown. |

Recommended read-tool contract: return an immutable bounded batch, `batch_id`,
`from_seq`, `through_seq`, `has_more`, and completeness warnings. Store a lease
so restarting a lead yields the same unfinished batch. A separate acknowledge
operation advances the cursor only through a contiguous committed batch, using
an expected cursor/version check. Reading a specific thread for context does
not advance the unread cursor. Filtered items still receive a durable
`ignored_by_policy` disposition so they do not recur forever.

Persist response/action intent before acknowledging work as consumed. A crash
after a read but before a reply must not lose the request, while a crash after a
sent reply must not make the lead execute the same command again. Deduplicate
external side effects by a stable action ID, not prompt text. A transport ack is
never evidence that the lead actually read anything.

Recommended agent tools, scoped by a bridge-issued binding capability:
`read_unread`, `read_thread`, `ack_batch`, `reply_to_request`,
`publish_update`, and `get_integration_status`. The agent should name a request
or schedule occurrence, not invent a channel/user destination. These are design
recommendations, not existing Toy Box API claims.

## 3. Recovery after downtime and pagination

`conversations.history` returns recent channel history newest first.
`conversations.replies` returns a root followed by its replies, oldest first.
Use the actual root timestamp when replying/fetching threads, not a reply's
timestamp. Treat pagination cursors as short-lived page tokens, not durable read
cursors. They expire and should not be persisted for hours/days. An empty or short
page can still have `next_cursor`, so page size is never a completion test.
The replies documentation's time-pagination prose is internally confusing about
which boundary to move. Prefer its documented `next_cursor` with fixed
`oldest`/`latest` bounds rather than copying that prose into custom paging logic.
[History order](https://docs.slack.dev/reference/methods/conversations.history/#pagination-time),
[replies order](https://docs.slack.dev/reference/methods/conversations.replies/#pagination-by-time),
[cursor contract and expiry](https://docs.slack.dev/apis/web-api/pagination/).

**Exact-source lookup, verified against the documentation on 2026-10-28.**
The `conversations.replies` argument contract accepts either a parent or a
message in its thread, but requires that timestamp to identify an existing
message. Its `thread_not_found` error means missing or invalid `ts`; the same
error can also mean a non-threadable join/leave message. Thus `thread_not_found`
for a deleted reply's own timestamp is an expectation, **not live-verified
evidence or an explicitly documented deleted-reply response**. Our protocol
fake implements that expectation and cannot independently establish it.
[Timestamp and error contract](https://docs.slack.dev/reference/methods/conversations.replies/).

Add the exact case to an approved live-probe batch: read an existing reply by
its own timestamp, delete that probe reply, then query its timestamp again
and separately read its surviving parent. Keep the parent and another reply
as controls. A failure at the source's timestamp must not tombstone the whole
thread. Cancelling an unusable request is a separate product policy from
asserting that a missing message proves a deletion event. No live call was made
under the standing credential/live-test restriction.

Recommended repair algorithm:

1. Establish event ingestion first. Take a fixed repair upper bound and record
   the last completed coverage interval. Use Slack timestamps where available
   and account for local clock skew if deriving a wall-clock boundary.
2. Read channel roots over `[previous coverage - overlap, repair upper bound]`,
   with `inclusive=true` and cursor pagination. Persist each page before moving
   on. Merge by canonical IDs and versions. Do not advance coverage until every
   page succeeds. On `invalid_cursor`, restart that fixed interval, deduping.
3. Inventory thread roots over the declared monitoring horizon, not just roots
   created since disconnection. A new reply can belong to a years-old root, and
   a previously unthreaded root can gain its first reply while the bridge is
   offline. A per-channel maximum message timestamp will miss this.
4. Re-read all known active/request threads and roots whose reply metadata
   changed. For a strict retained-root coverage claim, enumerate roots across
   all accessible retained history and reconcile relevant thread contents.
   Partial metadata is a hint, not proof that replies are complete.
5. To repair old edits/deletes, periodically compare complete in-scope snapshots
   of roots **and** replies. `latest_reply` alone cannot reveal an edit to an old
   reply. Do not mark missing records deleted after a partial scan or an access
   failure.
6. Merge concurrent live deliveries using message versions and overlap. Slack
   does not provide a transactional cross-page snapshot here. Repeat the tail
   as needed, then publish coverage/completeness status and wake the lead once
   for new authorized work.

**Honest guarantee:** events plus reconciliation can converge on accessible
current state within an explicit horizon. They cannot reconstruct a message
created and deleted entirely during downtime, an intermediate edit version,
retention-expired content, or data the bot cannot access. Hidden edit/delete
records are not returned by history.
[Hidden events](https://docs.slack.dev/reference/events/message/#hidden_subtypes),
[deleted messages disappear from history](https://docs.slack.dev/reference/events/message/message_deleted/),
[history limits](https://docs.slack.dev/reference/methods/conversations.history/).

Expose coverage such as `live_only`, `tracked_threads`, or
`retained_roots_reconciled`, along with the time horizon, outstanding repairs,
and retention/access gaps. A finite lookback is a product limitation, not an
implementation of "all channel threads recovered." For v1, default to explicit
live monitoring plus durable tracked threads and offer an initial retained-root
inventory. Do not call it fully caught up until the selected inventory/repair
has finished. Summaries and release notes must disclose material missing input.

## 4. Rate limits and backpressure

These are published allowances, not a plan to run continuously at the ceiling.
Rate limits are per method, app, and workspace, not per token. Different bot
tokens do not create extra quota. Slack does not publish a stable burst allowance.
Use a workspace/method scheduler, plus a channel write queue.
[Rate-limit model](https://docs.slack.dev/apis/web-api/rate-limits/).

| Method / feature | Current published limit | Consequence |
| --- | --- | --- |
| [history](https://docs.slack.dev/reference/methods/conversations.history/), [replies](https://docs.slack.dev/reference/methods/conversations.replies/) | Tier 3, 50+/min for internal/Marketplace apps. Affected new commercial unlisted apps: 1/min, max/default 15 objects. | Event-first, bounded prioritized repair. Use 100-200 pages for the internal profile, 15 for restricted installations. |
| [conversations.list](https://docs.slack.dev/reference/methods/conversations.list/) | Tier 2, 20+/min | Resolve at setup and cache, not before each message. |
| [conversations.info](https://docs.slack.dev/reference/methods/conversations.info/) | Tier 3, 50+/min | Refresh configured channels adaptively and on lifecycle changes. |
| [users.info](https://docs.slack.dev/reference/methods/users.info/) | Tier 4, 100+/min | Resolve IDs at configuration and cache bounded profile metadata. |
| [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/) | Generally 1 message/sec/channel plus a workspace limit of several hundred/min | Threads share their parent channel's write budget. Coalesce progress. |
| [chat.update](https://docs.slack.dev/reference/methods/chat.update/) | Tier 3, 50+/min | Debounce edits. Slack's agent-design guidance suggests at most one update every 3 seconds. |
| [reactions.add](https://docs.slack.dev/reference/methods/reactions.add/) | Tier 3, 50+/min | Do not let optional acknowledgement reactions starve actual responses. |
| [files.info](https://docs.slack.dev/reference/methods/files.info/), [getUploadURLExternal](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/), [completeUploadExternal](https://docs.slack.dev/reference/methods/files.completeUploadExternal/) | Tier 4, 100+/min each | Bound concurrent transfers and keep durable multi-stage upload state. |
| [apps.connections.open](https://docs.slack.dev/reference/methods/apps.connections.open/) | Tier 3, 50+/min | Reconnect backoff, no busy loop. |
| [chat.scheduleMessage](https://docs.slack.dev/reference/methods/chat.scheduleMessage/) | Tier 3, 50+/min | Not our reasoning scheduler. |
| [chat.startStream](https://docs.slack.dev/reference/methods/chat.startStream/) | Tier 2, 20+/min | Optional future feature, not v1. |
| [assistant.threads.setStatus](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/) | Special, default 600/min/app/workspace | Refresh only as needed and clear on terminal states. |
| Events API | 30,000 deliveries/hour/app/workspace | `app_rate_limited` means possible gaps that need explicit repair. |

The general history page currently reports max 999/default 100, while the
May 2025 FAQ describes 1,000 objects for internal apps. Neither justifies
depending on a 1,000-item page. Request 100-200 for internal installs, follow
returned cursors even if Slack caps pages, and persist the configured distribution
profile. Re-evaluate the distribution classification before public/commercial
release. A templated installation is not an exemption.
[May 2025 FAQ](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/).

On HTTP 429, persist `next_attempt_at >= now + Retry-After`, with jitter added
after the required delay. Cool down that workspace+method, not every workspace
or unrelated method. Reads may retry transient failures with bounded exponential
backoff. Authentication/scope/permission failures need intervention, not an
infinite retry loop. Leave the cursor unchanged on an unfinished page.
[429 behavior](https://docs.slack.dev/apis/web-api/rate-limits/#headers).

Configure SDK Web API calls with explicit finite timeouts,
`retryConfig: { retries: 0 }`, and `rejectRateLimitedCalls: true` when the durable
scheduler owns retries. The SDK otherwise retries failed calls up to ten times
over roughly thirty minutes and can pause its entire client queue on a 429.
That is useful for simple bots but undermines durable method-specific scheduling
and can duplicate a non-idempotent post after response loss. The spike reproduces
both outcomes. Socket connection-opening retries should have their own bounded,
observable policy instead of inheriting outbound-message retry semantics.
[SDK retry controls](https://docs.slack.dev/tools/node-slack-sdk/web-api/#automatic-retries),
[pinned queue/retry implementation](https://github.com/slackapi/node-slack-sdk/blob/a98047a7f27149812664c78e2dccfe4155b0e145/packages/web-api/src/WebClient.ts).

## 5. Posting and publications

### Threading, attribution, and delivery

Use `thread_ts = original root ts` and `reply_broadcast=false` for answers.
Publish daily/weekly summaries as one intentional root post unless the owner
chooses a standing release-notes thread. Thread replies are visible to everyone
who can see the channel, not only the allowlisted requester.
[Thread posting](https://docs.slack.dev/reference/methods/chat.postMessage/#threads).

Use one Toy Box bot identity and identify the channel lead in a small content
label if needed. Do not request `chat:write.customize` for v1. That scope lets
messages change username/avatar, Slack requires clear user permission and
signposting for impersonation, and its delete semantics have limitations. It is
not a way to turn local agents into actual Slack users.
[Customized authorship](https://docs.slack.dev/reference/methods/chat.postMessage/#authorship).

Persist a unique approved action key, target, request/schedule provenance,
content hash, policy version, attempts, and returned channel/`ts` in an outbox.
Recheck binding enabled state, requester allowlist, source version/deletion,
channel membership, destination sharing/privacy, and content approval at send
time. Keep `delivery_unknown` separate from retryable failure and from sent.
Only a successful response or a positive own-message metadata match resolves
the ambiguity. Do not claim that `client_msg_id` gives permanent exactly-once
delivery: the current method argument table provides no such contract.
[Method arguments and possible partial-success errors](https://docs.slack.dev/reference/methods/chat.postMessage/).

### Formatting

V1 should use conventional `section`/`context` blocks with Slack `mrkdwn` for
structured cards and safe text for ordinary replies. CommonMark and Slack
`mrkdwn` differ: `**bold**` is not Slack's `*bold*`, and Markdown links are not
Slack's `<url|label>`. For LLM-authored standard Markdown, the newer `markdown`
block lets Slack translate it and supports tables, lists, and code. Its combined
limit is 12,000 characters, it is documented for AI-feature apps, and its
`block_id` is not retained. Gate it behind a capability check instead of assuming
the no-container app renders it identically everywhere.
[Formatting](https://docs.slack.dev/messaging/formatting-message-text/),
[Markdown block](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/).

Supply a top-level fallback `text` containing the important content for
notifications and screen readers. For the reduced `markdown` payload, escape
only `<` before `@` or `!`, and break plain broadcast words with a zero-width
space. This neutralizes user, broadcast, group and date controls without
entity-escaping ordinary code or blockquotes. The live probes above establish
this behavior; do not apply legacy `mrkdwn` escaping to the Markdown block.
`parse=none`, `link_names=false`, and
`verbatim=true` where supported reduce automatic parsing but do not neutralize
explicit Slack mention syntax by themselves. Do not allow arbitrary model JSON
to become Block Kit.
[Escaping and mentions](https://docs.slack.dev/messaging/formatting-message-text/#escaping),
[automatic parsing](https://docs.slack.dev/messaging/formatting-message-text/#automatic-parsing).

Keep ordinary `text` near 4,000 characters. Slack truncates above 40,000.
Section text has its own 3,000-character limit, and messages allow up to 50
blocks. Reduced v1 uses one markdown block and refuses output above 12,000
characters rather than splitting or truncating it. Longer answers must be
rewritten.
Set `unfurl_links=false`,
`unfurl_media=false`, and, where available, `unfurl_app_links=false` for internal
or potentially sensitive links. Never post a private localhost Toy Box URL as if
Slack recipients could open it, and never expose Toy Box just to make it work.
[Text limits and unfurls](https://docs.slack.dev/reference/methods/chat.postMessage/),
[section block](https://docs.slack.dev/reference/block-kit/blocks/section-block/),
[block count](https://docs.slack.dev/reference/block-kit/blocks/).

For progress edits, keep the same own message channel/`ts` and send complete
`blocks` plus fallback `text` so `chat.update` retention rules cannot unexpectedly
remove or preserve stale blocks. Ephemeral messages are not durable and cannot
be edited with `chat.update`. They are unsuitable for request tracking.
[Update semantics](https://docs.slack.dev/reference/methods/chat.update/).

### Retired approval-card edits: a different wire contract

The current `chat.update` argument table supports `channel`, `ts`, `text`,
`blocks`, `parse`, and `metadata`, but does not list the post-only
`unfurl_links`, `unfurl_media`, or top-level `mrkdwn` controls. Do not copy a
post payload wholesale into an edit. Always send `parse=none`: its documented
default differs from posting and overwrites the message's previous setting.
The documented successful response has a top-level `ts` but no
`message.ts`. Confirm the known target from top-level channel and ts, and reject
contradictory nested fields without requiring that optional echo.
[Arguments, parsing, and response](https://docs.slack.dev/reference/methods/chat.update/).

The argument table provides no conditional version or compare-and-set option.
Treat a timed-out edit as potentially still executing remotely, not cancelled.
The pre-cut policy serialized edits per approval, rendered its current state for every
attempt, and superseded older queued or unknown updates. Only a card's first
post may contain decision buttons. Every update follows a decision and its
snapshot decoder rejects actions blocks, so a late older update can restore
an older decision label but not approval controls. This limits the damage
without promising remote ordering Slack has not documented.
[Timeout/partial-success contract](https://docs.slack.dev/reference/methods/chat.update/#errors).
Those card and snapshot guards were retired with approvals and are not part
of the current outbox.

On 2026-10-28 the Lead reported six live-message probes with no unfurls on
edits to messages initially posted with unfurls disabled, including adding
links. This is attributed workspace evidence from channel message 203, not
an independent live verification by this author or a published Slack
guarantee about inherited unfurl settings.

### Reading uncertain delivery without reposting

Reduced v1 makes two positive-only metadata checks, around one and five
minutes after the attempt. Readers request `include_all_metadata=true` and
follow cursors, including empty pages. Slack documents that a short page does
not prove exhaustion and recommends no more than 200 results per cursor page.
Publication history is bounded to five minutes either side of the attempt,
not the queue time. Answers are read in their intended thread.
[History and timestamp bounds](https://docs.slack.dev/reference/methods/conversations.history/),
[thread pagination and metadata](https://docs.slack.dev/reference/methods/conversations.replies/).

Confirmation requires our bot/app, exact metadata and the intended channel
and thread. Text alone, a misplaced post or a missing match proves nothing.
Incomplete or failed reads leave the item unknown without spending a check.
Pagination is local to one check and restarts after interruption; there is no
persisted page continuation. After two complete misses the item remains unknown
and reserved. Neither a miss nor restarting permits another send.
[Reconciliation implementation](../../src/features/outbox/server/reconcile.ts),
[credential-free protocol cases](../../src/features/outbox/server/posts.test.ts).

One shared bot client holds per-method cooldowns in memory. A 429 defers only
that method until `Retry-After`, with SDK retries disabled. Restart may encounter
another 429 but cannot release a post reservation.
[Client and cooldown cases](../../tests/integration/slackBotClient.test.ts).

### Withdrawal without inventing answer proof

`chat.delete` requires `chat:write` and permits a bot token to delete only its
own messages. Its documented success identifies channel and ts, and
`message_not_found` means no message exists at that target.
[Delete contract](https://docs.slack.dev/reference/methods/chat.delete/).

Reduced v1's `retract` accepts a known post belonging to the caller's link,
not an arbitrary Slack target. A matching delete receipt or `message_not_found`
confirms removal. Otherwise the command reports that deletion is unconfirmed,
and retrying the same known target is safe. Retraction never frees the request
or publication slot. There is no generalized orphan cleanup, approval retirement
or durable reaction state. Eyes are fire-and-forget when inbox serves a request.
[Retraction implementation](../../src/features/outbox/server/retract.ts),
[delivery and retraction cases](../../src/features/outbox/server/posts.test.ts).

### Daily and weekly releases

Use a durable local occurrence key such as `(binding, schedule, intended_time)`.
Wake the lead, read the configured source range, produce a public-facing draft,
and post through the normal authorized outbox. Define IANA time zone, DST
behavior, catch-up policy, quiet hours, overlap prevention, and what happens if
the previous run remains active. Prefer one summarized missed-run publication
over flooding the channel after a long outage.

`chat.scheduleMessage` only schedules an already composed message. Its current
limits are 120 days into the future and no more than 30 messages per five-minute
window in one channel. It also documents a bug where messages using `metadata`
do not post. Avoid it for our correlated recurring output.
[Scheduling contract and metadata bug](https://docs.slack.dev/reference/methods/chat.scheduleMessage/).

## 6. Current agent UX, without adopting unnecessary surfaces

Slack's June 30, 2026 Agent messaging experience uses `features.agent_view`.
New apps cannot choose the older `assistant_view`. This is not a reason to add
DMs to a channel-monitoring product. If we later offer an agent container,
declare `agent_view`, add `assistant:write`, route DM conversations explicitly,
and test the paid-plan features. Do not ship a new manifest copied from a 2025
assistant tutorial.
[Dated change](https://docs.slack.dev/changelog/2026/06/30/agent-messages-tab/),
[current manifest](https://docs.slack.dev/reference/app-manifest/#features),
[paid-plan qualification](https://docs.slack.dev/ai/developing-agents/).

Current agent-session methods are `agents.sessions.setStatus` and
`agents.sessions.rename`, replacing legacy `assistant.threads.*` methods through
a compatibility bridge. Session lifecycle is `processing`, `active`,
`suspended`, and `closed`. Only declared agent apps can create sessions.
`processing` times out after one hour unless refreshed. A subscribed
`agent_session_stopped` event enables the native stop button, but clicking it
does not itself cancel Toy Box work or transition status: the integration must
do that. Do not display a stop affordance until cancellation actually reaches
the running worker and suppresses pending writes.
[Sessions and cancellation](https://docs.slack.dev/ai/agent-sessions/),
[status method](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/).

The current general design guide mentions `agents.sessions.create`, whereas the
dedicated session guide and method reference recommend create-if-needed
`agents.sessions.setStatus`. Use the latter specific documented contract rather
than introducing a guessed method.
[General design guide](https://docs.slack.dev/concepts/agent-design/).

Recommended channel etiquette: acknowledge only accepted requests, answer in
thread, keep progress brief and meaningful, cite Slack source permalinks,
separate observation from action, and publish one useful final result. Default
to explicit bot mentions from allowlisted users plus allowlisted follow-ups in
an already owned request thread. A generic message elsewhere in a monitored
channel is context, not a command. Offer broader question-answering modes as an
explicit owner policy, not as unbounded model discretion.
[Slack's transparency/data-boundary guidance](https://docs.slack.dev/concepts/agent-design/),
[permalink method](https://docs.slack.dev/reference/methods/chat.getPermalink/).

## 7. Installation identity, access, and policy

Use a bound installation identity validated at startup, the immutable configured
channel ID, and explicit Slack user IDs. Resolve display names only for UI.
User IDs may use `U` or `W` prefixes. Never authorize by display name, email text
inside a message, the person being quoted, or the `authorizations` array, which
describes installation visibility rather than the speaker's permission to make
requests. `users:read.email` is unnecessary for an ID allowlist.
[User response example](https://docs.slack.dev/reference/methods/users.info/),
[event authorizations](https://docs.slack.dev/apis/events-api/#callback-field).

Separate these policy dimensions:

| Permission | Recommended default |
| --- | --- |
| Channels whose content may be collected | Only configured bindings, never all channels the bot joins. |
| Authors whose content may be observed | Explicit owner-configured monitoring scope. |
| People who may issue requests | Explicit user-ID allowlist, denied by default. |
| Recipients/destinations for answers and publications | The same bound Slack channel and request thread, or an explicitly configured publication destination. |
| Actions authorized from Slack | Narrow approved action classes. Observation never grants shell/secret/network authority. |
| Data allowed in output | Explicit public-facing response/draft, never all internal Toy Box messages. |

The bot must be invited to each private channel. Do not request
`chat:write.public` or `channels:join` just to avoid membership checks. Verify
membership and channel type at setup and on reconnect. `not_in_channel`,
`channel_not_found`, `missing_scope`, and `no_permission` are explicit degraded
states, not empty history or a reason to widen scopes automatically.
[Scope semantics](https://docs.slack.dev/reference/scopes/),
[history token visibility](https://docs.slack.dev/reference/methods/conversations.history/#usage-info).

**Slack Connect is off by default.** An installed workspace's event wrapper
does not prove the author belongs to that workspace. External users can be
visible in shared channels, names and privacy can differ on each side, channel
IDs can migrate, and `is_stranger` only covers a particular class of external
users. Use `conversations.info.is_ext_shared`, authoritative user/team fields,
and explicit external-user consent. Detect a channel becoming shared and pause
publication before the next write. A complete lack of fresh privacy metadata
must block sensitive output, not preserve a stale "internal" assumption.
[Slack Connect behavior and sharing warnings](https://docs.slack.dev/apis/slack-connect/),
[ID migration](https://docs.slack.dev/reference/events/channel_id_changed/).

On `tokens_revoked`, match revoked **user IDs** to installation credentials.
The event does not contain token strings. On `app_uninstalled`, mark the
installation inactive, stop collection/wakes/scheduled sends, cancel queued
writes, and apply the data-deletion policy. These events can arrive in either
order. Authentication failures may be the only signal if the Socket Mode token
itself stops working, so monitor both event and API paths.
[Revocation](https://docs.slack.dev/reference/events/tokens_revoked/),
[uninstall ordering](https://docs.slack.dev/reference/events/app_uninstalled/).

## 8. Files and images

For inbound files, use IDs from an authorized message rather than fetching
arbitrary URLs supplied by a user/model. Slack Connect can return partial file
objects requiring `files.info`. Track unavailable/deleted/processing files as
such and let text-only handling continue with an explicit attachment warning.
Apply byte count, total attachment count, timeout, MIME/magic-byte checks,
decompressed size, image dimension limits, and per-binding quotas before model
ingestion. Filenames are untrusted metadata, never destination paths.
[File object and partial access](https://docs.slack.dev/reference/objects/file-object/),
[file info](https://docs.slack.dev/reference/methods/files.info/).

For `file_deleted`, purge downloaded bytes and derived caches for that ID, and
remove it from future context. Slack explicitly does not emit this event for
files removed by retention policy. Local TTL/deletion jobs and periodic access
reconciliation are therefore necessary; absence of a deletion event is not
permission to retain the file indefinitely.
[Deletion event and retention exception](https://docs.slack.dev/reference/events/file_deleted/).

**Never attach a Slack token merely because a field is named `url_private`.**
Remote-file integrations can supply arbitrary external URLs in that field.
For Slack-hosted content, require HTTPS and an exact configured Slack file host,
such as `files.slack.com`, before attaching `Authorization: Bearer ...`.
Reject URL credentials, lookalike domains, unexpected ports and private-address
targets. Disable redirects or validate each hop and strip credentials on any
non-allowlisted target. Treat external files as external links and do not fetch
them automatically. Do not pass token-bearing URLs to models, Slack blocks,
browser rendering, or logs.
[Slack's explicit download security guidance](https://docs.slack.dev/messaging/working-with-files/#download).

`files.upload` sunset on November 12, 2025. The supported upload is:
`files.getUploadURLExternal` -> binary POST to returned upload URL ->
`files.completeUploadExternal`. `filesUploadV2` wraps these stages, and our
runtime spike proves a binary/threaded round trip against a fake. Production
recovery should retain file ID, stage, content hash and target so a crash does
not restart the whole flow with a fresh duplicate file. Completion may be called
only once. Its response loss needs reconciliation, not unlimited repeats.
Without `channel_id` the upload remains private to the token holder.
[Sunset](https://docs.slack.dev/reference/methods/files.upload/),
[upload steps](https://docs.slack.dev/messaging/working-with-files/),
[completion contract](https://docs.slack.dev/reference/methods/files.completeUploadExternal/).

The SDK helper buffers file contents in memory. Keep v1 file-size/concurrency
limits conservative and use an explicit staged transfer if resumability or
larger files are needed. In 8.2.0 the upload request reuses the client's default
Authorization headers. The helper also bypasses API-method URL derivation, so
`allowAbsoluteUrls: false` does not validate its server-returned upload URL.
Validate that HTTPS upload host, use a constrained fetch/transport, reject
unexpected redirects, and never let an agent supply an upload URL or arbitrary
SDK method. The pinned implementation uses `redirect: "error"`.
[Pinned upload/request implementation](https://github.com/slackapi/node-slack-sdk/blob/a98047a7f27149812664c78e2dccfe4155b0e145/packages/web-api/src/WebClient.ts),
[pinned buffering implementation](https://github.com/slackapi/node-slack-sdk/blob/a98047a7f27149812664c78e2dccfe4155b0e145/packages/web-api/src/file-upload.ts).

For a Slack-hosted output image use:

```json
{
  "type": "image",
  "slack_file": { "id": "F..." },
  "alt_text": "Meaningful description of the published image"
}
```

Upload/share the image to the intended channel first and verify appropriate
access. `slack_file` accepts exactly one of `id` or `url`, and currently supports
PNG/JPG/JPEG/GIF. It avoids publishing a private authenticated URL as a public
`image_url`. The file needs to be accessible to its poster, and a successfully
uploaded file is not by itself proof that every intended recipient can view it.
[Slack file composition object](https://docs.slack.dev/reference/block-kit/composition-objects/slack-file-object/).

## 9. Security, data boundaries, and operations

This is a threat model and implementation guidance, not an exploit audit of a
finished bridge. Toy Box has shell-capable agents and no authentication, so a
Slack message is an untrusted external input crossing a high-impact boundary.
The bridge must not treat a quoted instruction or someone else's thread message
as the Toy Box owner. Delimiters, provenance labels, and system-prompt wording
help comprehension but are not an execution sandbox.

Keep Slack credentials exclusively in the bridge process, outside artifacts and
agent context. A gitignored `.env.local` is acceptable for local development
with restrictive file permissions, no shell tracing, and redacted errors.
Production should use a service-owned secret file or OS secret store.
Redact tokens, refresh tokens, response URLs, connection tickets, request bodies,
and file URLs from structured logs. Turn off SDK debug payload logging.
Tests must inject credentials explicitly and refuse accidental live endpoints.
Bun's test environment handling is useful defense in depth, not the sole
barrier against test code using an inherited environment variable.
[SDK debug logging](https://docs.slack.dev/tools/node-slack-sdk/web-api/#logging),
[Socket SDK raw-message logger](https://github.com/slackapi/node-slack-sdk/blob/a98047a7f27149812664c78e2dccfe4155b0e145/packages/socket-mode/src/SocketModeClient.ts).

Enforce binding capabilities in bridge tools and do not expose arbitrary Slack
API method names, tokens, filesystem paths, or destinations. Bind local RPC to
loopback or a Unix socket and require a capability even there. Keep the Toy Box
API private. Validate configured Toy Box origins and all upload/download targets
against SSRF/credential-forwarding risks. Do not turn a Slack URL into a
network-fetch instruction or put raw text into a shell command.

**Important residual risk:** if the agent runs under the same OS identity with
unrestricted shell access, hiding tokens from its prompt is not a security
boundary. It can read that identity's files/environment or reach unauthenticated
local services. For stronger protection, run the bridge as a separate user and
use a sandboxed/read-only monitoring worker with narrowly scoped tool
capabilities. A generic owner-level Toy Box lead cannot safely become an
unrestricted autonomous executor for arbitrary Slack users just because a
prompt says "treat this as untrusted." Publish that limitation honestly.

Never mirror every internal Toy Box response. The lead should intentionally
compose Slack-safe replies, release notes, or discussion summaries through a
dedicated publication action. Separate routine status from model reasoning,
tool output, local paths, private repository content, other channels, and
credentials. An allowlisted requester does not authorize disclosure to everyone
else in a Slack channel or to Slack Connect partners.
[Slack's data-boundary guidance](https://docs.slack.dev/concepts/agent-design/#how-agents-show-up),
[external-channel warning](https://docs.slack.dev/apis/slack-connect/#design-considerations).

The current Developer Policy requires appropriate consent for collecting,
storing and using Slack data, prohibits training an LLM on it, requires strong
encryption for stored/served data, and requires deletion of associated data
within 14 business days after app deletion/discontinuation. Establish local
retention, encrypted storage/backups, deletion procedures, and a clear notice of
which agent providers process selected Slack content before live deployment.
Do not assume the installer alone can waive workplace policy or authorize
unrelated private data being sent to a model provider. This research makes no
legal determination about a particular provider contract.
[Developer Policy, effective December 10, 2024](https://docs.slack.dev/developer-policy/).

The test manifest leaves token rotation off to avoid an unimplemented expiry
path. For a production deployment consider rotation only after implementing
atomic refresh-token replacement and single-flight refresh. Slack access tokens
with rotation expire after 12 hours, refresh tokens rotate, and enabling rotation
cannot simply be undone. The current guide also includes app-level token
rotation, so do not assume the Socket Mode credential is permanently exempt.
[Rotation contract](https://docs.slack.dev/authentication/using-token-rotation/).

Recommended health states: `starting`, `connected`, `repairing`,
`degraded_permissions`, `degraded_storage`, `rate_limited`, `delivery_unknown`,
`paused_by_policy`, and `uninstalled`. Report last successful receive, last ack,
oldest inbox age, repair coverage, agent unread age, queue sizes, pending
publication age, method-specific cooldown, reconnect count, and last sanitized
error. A connected socket is not evidence that monitoring is complete or that
the lead is answering.

### Operator actions

| Condition | Runbook |
| --- | --- |
| First startup / credential replacement | Validate installation identity, granted scopes, configured channel membership and exact destinations. Keep publication paused until capability probes succeed. Never print tokens in diagnostics. |
| Socket outage / long sleep | Inspect sanitized disconnect reason and reconnect age, repair the recorded gap, show selected recovery horizon, and avoid declaring the agent caught up while thread repair remains pending. |
| Rate-limited repair | Respect method-specific persisted cooldowns, prioritize pending request threads over broad inventory, and show estimated coverage lag rather than increasing concurrency or tokens. |
| Unknown post outcome | Pause that logical action, inspect app-authored metadata in its target, and let an operator link the found `ts`, cancel, or explicitly authorize a duplicate-risk resend. Never automatically republish the whole report. |
| Membership/privacy/share change | Pause affected output, refresh channel flags, and require explicit owner reapproval for a wider destination. Do not relink by a reused channel name. |
| Uninstall / revocation | Disable the installation, hold work, remove credentials and apply the deletion policy. A reinstall gets a newly validated identity/configuration, not an automatic replay of stale queued commands. |
| Storage failure / restore | Preserve failed checkpoints, restore an encrypted backup, run deduping repair, and reconcile unknown writes before resuming the outbox. Test restore procedures, not only backup creation. |
| Retention/deletion request | Purge source payloads, downloaded files, derived summaries/caches and applicable backups on the defined schedule while retaining only the minimum non-content audit state the policy permits. |

## 10. Tests and live acceptance

### Test layers

| Layer | Required coverage |
| --- | --- |
| Pure unit | Timestamp comparison including equal/adjacent decimal IDs, subtype normalization, root/reply identity, mention escaping, allowlist/binding checks, policy changes, file-URL validation, cursor compare-and-swap, schedule DST/catch-up. |
| Database integration | Crash before/after inbox commit and ack, duplicate event deliveries, stale creates after tombstones, lease expiry, concurrent readers, outbox uniqueness, response-loss unknown state, disk-full errors, checkpoint rollback. |
| Slack protocol fake | Real WebSocket hello/ack/ping/pong/close/refresh, changed envelope IDs with same event ID, disordered events, top-level control payloads, forced close, missing heartbeat and reconnect. |
| Web API fake | HTTP-200 `ok:false`, 429 and `Retry-After`, transport loss after accepted post, metadata rejected/missing, partial pages and expired cursors, old-root new replies, file processing/download/redirect failures, three-stage upload. |
| Bridge end-to-end | Fake Slack + real bridge + isolated Toy Box or faithful Toy Box fake, wake/read-thread/reply/update/restart/publish path, and negative assertions that denied/unconfigured input never reaches an agent. |
| Live, opt-in | Workspace capability probes, actual mention/status/rendering/thread behavior, private-channel permissions, tokens and recovery. No claims of live validation until run with explicit test credentials. |

The checked-in spike supplies eight narrow SDK/protocol characterizations, not
the whole bridge test suite. Its known-gap test succeeds by asserting the SDK
rejects an unsupported shape. Do not report that as support for rate-limit
notifications.

Fake Slack must generate payloads from the official event shapes above, not
from our normalizer's desired shape. Keep event identity separate from envelope
identity and never make the fake `chat.postMessage` magically idempotent.
Use ephemeral loopback ports, exact fake tokens, explicit API URLs, finite
timeouts and cleanup hooks. The SDK exposes `slackApiUrl` specifically for test
endpoints. Every fake method should reject unknown operations, not return a
success-shaped default.
[Custom SDK API URL](https://docs.slack.dev/tools/node-slack-sdk/web-api/#custom-api-url).

### Live checklist

1. Validate/install the manifest in a dedicated test workspace. Verify app and
   bot installation identity, subscribed events, and each required granted scope.
2. Invite the app to one public and one private test channel. Probe history and
   replies with the bot token, including a root older than bridge startup and a
   thread with enough replies to paginate.
3. Verify that an invitation alone does not create a binding or retain content.
   Configure an explicit binding and two test identities, one allowlisted and
   one denied. Denied users must not wake the lead or trigger side effects.
4. Send a mention, a non-mention observation, and thread follow-ups from both
   identities. Check attribution and same-root threaded answers. Verify a bot
   reply cannot cause another request loop.
5. Probe `assistant.threads.setStatus` in a channel thread with the Messages tab
   disabled and no AI declaration. Verify expiry/clear behavior and final reply.
6. Post custom outbox metadata, recover it from both history and replies using
   `include_all_metadata=true`, and verify matching by actual app/bot identity.
   Simulate a dropped response only in a controlled transport harness.
7. Edit/delete queued and already processed questions. Check no stale execution,
   no resurrection, and explicit correction rather than pretend rollback.
8. Disconnect/restart the bridge, create a root message and replies to old roots,
   then verify the declared recovery horizon and cursors. Repeat across machine
   sleep and a long-lived Socket Mode rotation.
9. Rename/archive/unarchive the channels, remove/reinvite the bot, and convert
   public/private where the workspace permits it. Confirm pause and explicit
   recovery without auto-widening authorization.
10. Send hosted and remote files, large/unsupported files, and an image. Confirm
    private downloading, remote-host refusal, uploadV2 targeting and Slack-file
    rendering without exposing authenticated URLs.
11. Run one release-note schedule occurrence twice through a restart. Confirm a
    single intended outbox action, truthful source coverage, no raw internal
    transcript, and correct timezone behavior.
12. Revoke test tokens/uninstall and verify stop/cleanup paths. Test Slack
    Connect only in a separately authorized shared test channel before enabling
    that feature. Record workspace plan, scopes, runtime/SDK versions, dates,
    exact results, and remaining gaps.

## 11. Failure matrix

These are recommended treatments of the documented behaviors, not claims that
an implementation already handles them.

| Failure / edge case | Required handling |
| --- | --- |
| Duplicate delivery, changed envelope ID | Ack each envelope, unique event inbox, one logical request. |
| Same message from events, backfill, broadcast, or mention subscription | Merge canonical message/version identity before classification. |
| Out-of-order create/edit/delete | Version-aware upserts and tombstones, no resurrection. |
| Malformed/unknown payload | Explicit sanitized diagnostic and bounded quarantine, no success-shaped parse defaults. |
| Top-level `app_rate_limited` | Receiver gap must be resolved, mark recovery gap and throttle repair. |
| Socket rotation, network partition, laptop sleep | Reconnect with fresh URL/backoff and repair declared coverage. |
| Two bridge processes | Single writer/lease or shared transactional inbox/outbox, no independent cursors. |
| Storage failure or full disk | Stop acking accepted-but-uncommitted input, surface unhealthy, preserve existing checkpoints. |
| Agent busy or wake lost | Durable unread work, debounced level-triggered wake, retry until cursor advances. |
| Lead crashes after reading | Stable batch lease and unconsumed action intents survive restart. |
| Lead repeats a tool call | Stable action ID returns existing action status, not another send. |
| Channel high-water advances past missed old-thread replies | Separate root inventory and thread repair coverage. |
| Cursor expires, empty page, rate limit mid-page | Restart fixed interval on invalid cursor, follow next_cursor, do not advance unfinished coverage. |
| Retention/free-plan/access limit | Mark partial coverage, do not invent messages or infer a completed full history. |
| Edited queued request | Replace/reclassify latest version and invalidate stale action approval. |
| Deleted queued request | Cancel uncommitted actions, retain minimal tombstone, do not claim to undo already executed work. |
| Unauthorized user inside an authorized thread | Context only if permitted, never inherits the thread starter's execution authority. |
| Other app/bot or self-post | No executable wake loop, opt-in observation only. |
| Unconfigured channel, even if bot invited | Ack/drop without content persistence or model ingestion. |
| Channel rename/privacy/share/ID change | Refresh authoritative metadata, migrate only Slack-confirmed aliases, pause widened/external disclosure. |
| Bot kicked, channel deleted/archived, token revoked | Suspend binding/install as appropriate and surface intervention, do not silently poll empty results. |
| 429 | Durable workspace/method cooldown from Retry-After, channel write pacing. |
| 5xx/timeout after post | Possible partial success, `delivery_unknown`, own-metadata reconciliation. |
| Metadata missing/rejected or message later deleted | Positive matches resolve delivery, absence does not authorize blind resend. |
| Thread root deleted or thread locked | Report delivery failure, no automatic public root fallback. |
| Overlong output or Block Kit rejection | Prevalidate limits, deterministic segmentation/report upload, disclose any truncation. |
| File metadata incomplete/scanning/no access/deleted | Bounded retry only when transient, explicit unsupported/unavailable attachment state. |
| Remote `url_private` or malicious redirect | No credential forwarding or automatic external fetch. |
| Crash during file upload/completion | Durable file ID/stage, reconcile before restarting completion or allocating another file. |
| Weekly schedule after long outage | Occurrence-key dedupe, defined catch-up policy, disclose coverage gaps. |
| Model leaks paths, hidden reasoning, cross-channel data | Intentional publication boundary and output policy, never transcript mirroring. |
| Allowlist/config changes while queued | Check current policy again at execution and send time, cancel revoked authority. |
| Bridge healthy but model/provider unavailable | Visible pending/degraded status and bounded retry, never mark requests answered. |
| Uninstall races token-revocation events | Idempotent installation disable/cleanup independent of ordering. |

## 12. Open production gates

1. Live bot-token history/replies and metadata round-trip capabilities under the
   exact installed scopes, plus channel status with the app Messages tab off.
2. SDK top-level control-payload handling, real network refresh/heartbeat/proxy
   behavior, and longer Bun suspend/resume soak coverage.
3. Product agreement on monitoring horizon and freshness, then prove old-root
   repair at the chosen rate-limit profile rather than assuming it scales.
4. An actual isolation boundary for untrusted Slack observations reaching a
   shell-capable lead, plus provider/data consent and retention/deletion policy.
5. Bridge-owned cursor, outbox, wake, cancellation and authorization tests
   integrated with Toy Box's actual contracts. Those seams are being studied in
   the separate Toy Box research document.

## Architecture review, 2026-10-28

Review of the architecture brief shared in channel message 20. The brief itself
was not edited. These findings use its section/record IDs so the lead can fold
in the changes. The local bridge, no transcript mirroring, explicit receiver
adapter, method cooldowns, no-container channel status, and separate digest and
request state are sound. The following contracts need correction before they
become implementation requirements.

### R1. Acknowledged input is not power-loss durable under NORMAL

**Targets:** `px-data`, `startup`, `s2`, `fx-storage`.

**Addressed:** the lead incorporated FULL, lock-before-open ordering, and pragma
readback criteria in channel message 22. Retained here as review rationale.

The database specifies WAL with `synchronous=NORMAL`. SQLite explicitly says
this omits the per-commit WAL sync and can roll back committed transactions after
power loss or hard reboot. If Slack already received the ack, both a request and
the only durable record that a post was `sending` can disappear.

**Fix:** use WAL plus `synchronous=FULL` for the bridge database, verify the
effective pragmas, and distinguish an ordinary process crash from power-loss
testing. Take the bridge lock before migrations or any other database writes,
not afterward as the startup list currently orders it. Add a check that a second
process cannot run a migration or change the file.
[SQLite's exact durability tradeoff](https://www.sqlite.org/wal.html#performance_considerations).

### R2. Edits can leave an obsolete answer queued for delivery

**Targets:** `px-classify`, `px-lifecycle`, `px-data`, `outbound`,
`fx-edited-request`, `s3`, `s6`.

An edit marks a seen/in-progress request `updated`, but queued output has no
source revision and the send check only rejects cancellation. An answer to the
old request can still leave the outbox after the requester changed it. Grouping
more messages into an existing request has the same race. A language-detection
metadata event can also wake the lead despite no substantive change.

**Fix:** give every request a monotonic input revision based on substantive
content changes. `inbox` returns the revision the lead consumed, and reply intent
records it. Refuse or invalidate a queued final answer whose revision is stale,
surface `updated`, and require a new read before recomposition. Persist a
content fingerprint so bookkeeping/language-only changes do not advance that
revision. Deletion or removal of the request's required mention must invalidate
uncommitted output even if the lead already saw it. This need not pretend it can
undo work already performed.
[Edit payload and language-only events](https://docs.slack.dev/reference/events/message/message_changed/).

### R3. Queued is not answered, and a text hash is not an action key

**Targets:** `px-lifecycle`, `fx-lead-repeats`, `px-data`, `slack-feedback`,
`comp-scheduler`, `s6`.

The lifecycle calls a request `answered` as soon as the outbox accepts its final
reply. The feedback list then adds a checkmark although the post might remain
rate-limited, fail, or become `delivery_unknown`. A hash-only duplicate check
also permits the same logical final answer twice if a restarted lead changes
one word. A sent publication becomes eligible again if it is retracted because
the partial unique index excludes `retracted`.

**Fix:** introduce pending-response/delivery state, or derive it from the outbox,
and suppress redundant lead wakes while it is queued/sending/unknown. Move
`answered` and its completion reaction only after a successful response or a
positive metadata reconciliation. Unresolved delivery is visibly pending,
never a request for the lead to draft another answer.

Give each logical response a stable key such as `(request, consumed revision,
phase)`, with a database uniqueness constraint. A follow-up after the final
answer needs an explicit new action or new input revision, not the same command
silently creating another final reply. Preserve a publication-occurrence
tombstone across retraction. Only an explicit operator resend may cross the
normal no-resend boundary, and it must warn that duplication is possible.
These are local idempotency guarantees, not a Slack exactly-once contract.
[Non-idempotent posting contract](https://docs.slack.dev/reference/methods/chat.postMessage/).

### R4. HTTP 200 can still mean uncertain partial success

**Targets:** `outbound`, `fx-delivery-unknown`, `comp-outbox`, `s6`.

Unknown outcomes currently name timeout/network/HTTP-5xx only. Slack often
returns HTTP 200 with `ok:false`. For `chat.postMessage`, the `internal_error`
and `fatal_error` descriptions explicitly allow partial success. These must
not become an ordinary failed item that a fresh draft or automatic retry can
replace.

**Fix:** classify by method and Slack error code as well as HTTP/transport
status. Route documented partial-success errors into `delivery_unknown`.
Reconciliation must paginate the entire known target thread or bounded root-post
range and match the actual bot/app identity, channel, root, outbox ID, and
metadata payload hash. Check warnings because invalid metadata can be ignored.
Preserve the original intended payload hash rather than requiring exact equality
with Slack-normalized returned text.

Three read attempts over two minutes are a local best-effort policy, not a
delivery guarantee. They must obey persisted method cooldowns and cannot require
three full thread scans inside that time on a restricted 1/min installation.
No match, access loss, missing metadata, or a later deletion must leave the
outcome unknown. A failed cleanup of a stray root post likewise needs its own
visible state, not "failed and deleted" success.
[Partial-success errors](https://docs.slack.dev/reference/methods/chat.postMessage/#errors),
[metadata warnings](https://docs.slack.dev/messaging/message-metadata/#defining),
[pagination](https://docs.slack.dev/apis/web-api/pagination/).

### R5. ID changes and pending sharing cannot preserve an active link

**Targets:** `fx-id-change`, `fx-shared`, `channel_info` in `px-data`,
`outbound`, `s8`.

`fx-id-change` says to keep the link working under its new ID. Slack currently
documents this event specifically for a private channel being shared externally,
which v1 prohibits. The cached `is_shared` field also omits
`is_pending_ext_shared`, for which Slack explicitly recommends shared-channel
treatment. A private-to-public conversion broadens the audience without any
external-share flag.

**Fix:** on a Slack-authenticated ID migration, record/migrate aliases
transactionally but immediately pause publication and invalidate metadata.
Re-read the new conversation before any send. Persist explicit
`is_ext_shared`, `is_pending_ext_shared`, `is_org_shared`, channel kind and
privacy flags. Reject DMs/MPIMs and pending/external sharing during link and
resume, and handle conversion notices as lifecycle signals. Require owner
reapproval before sensitive output after a private channel becomes public.

A ten-minute cache is a bounded-staleness tradeoff, not proof the destination
remains internal. Invalidate it on every relevant signal, refresh on reconnect,
and use fresh channel checks for sensitive posts. A Slack-side audience change
can still race a send, so do not claim atomic destination authorization.
[ID-change circumstances](https://docs.slack.dev/reference/events/channel_id_changed/),
[sharing flags and pending warning](https://docs.slack.dev/reference/objects/conversation-object/#booleans),
[public conversion](https://docs.slack.dev/reference/events/message/channel_convert_to_public/).

### R6. Repair cannot justify the brief's no-loss guarantee

**Targets:** `outcome`, `comp-repair`, `coverage` in `px-data`,
`px-inbox`, `fx-untracked-thread`, `fx-deleted-request`, `acceptance`, `s4`.

Tracked-thread-only recovery is an acceptable explicit v1 limitation, but the
opening promises "nothing is lost" and restart acceptance promises every
request. They contradict `fx-untracked-thread`. A missed edit/delete of a
previously stored root can also be older than the channel gap range. History
does not replay the hidden deletion event. That leaves a queued request looking
live even after its source was deleted during the outage.

**Fix:** retain the v1 limitation but make coverage authoritative and visible:
channel-root range, tracked-thread range, last repair, and known/unknown
outage gaps. Replace the unqualified `caught up` banner and no-loss acceptance
with an explicit selected coverage guarantee. Add fixed range bounds,
cursor continuation through empty/short pages, `invalid_cursor` restart, and
live-before-repair merge rules to s4's completion tests.

Before resuming pending requests after an outage, refresh their authoritative
source messages/threads. Reclassify changed versions and block side effects
when the source can no longer be established. Do not equate inaccessible,
retention-hidden, or partially scanned data with a confirmed human deletion.
Either implement complete in-scope current-state reconciliation for stored
old content or disclose that missed edits/deletes remain a limitation too.
Exact intermediate event replay remains impossible.
[Hidden event limitations](https://docs.slack.dev/reference/events/message/#hidden_subtypes),
[history](https://docs.slack.dev/reference/methods/conversations.history/),
[replies](https://docs.slack.dev/reference/methods/conversations.replies/),
[cursor completion/expiry](https://docs.slack.dev/apis/web-api/pagination/).

### R7. Classification needs normalized human-request eligibility

**Targets:** `px-classify`, `comp-ledger`, `fx-duplicate`, `s3`.

The pseudocode rejects `botId` and self, but not `app_id`, other bot-user
identities, lifecycle notices or parent bookkeeping. An allowlisted actor's
join/topic/conversion event can contain bot mentions without being a request.
`message_replied` can carry root text again. A root can also have
`thread_ts === ts`, so testing merely whether `threadTs` exists is incorrect
for `--requests all` and follow-up classification.

**Fix:** normalization produces `rootTs`, `isReply = threadTs !== ts`,
provenance and `humanRequestEligible`. Only actual human message content and
explicitly supported message subtypes enter classification. Fold edits into
that canonical message, dedupe broadcasts by message identity, and exclude all
app/bot/self and lifecycle/bookkeeping content from executable requests. Use
the outer installation/team as delivery context, not as proof of the human's
home organization. Do not reject ordinary messages simply because the optional
inner `message.team` field is absent.
[Message event/subtype catalog](https://docs.slack.dev/reference/events/message/),
[thread identity](https://docs.slack.dev/messaging/retrieving-messages/#finding_threads),
[broadcast reference](https://docs.slack.dev/reference/events/message/thread_broadcast/).

### R8. Credential errors must not erase the data store

**Targets:** `fx-uninstall`, `trust`, `startup`, `s8`.

The brief purges everything on `invalid_auth` from any call or any
`tokens_revoked` event. A mistyped/replaced local token, access-policy failure,
or an unrelated user-token revocation is not proof the bot installation was
removed.

**Fix:** suspend collection/publication and surface an authentication repair
state on credential failure without immediately destroying data. For revocation
events, match the wrapper app/workspace and the bot-user IDs in `tokens.bot`
against this installation. Apply the deliberate revocation/uninstall deletion
policy only to the affected installation. Make duplicate/reordered uninstall
and revocation handling idempotent.
[Revoked values are user IDs, not tokens](https://docs.slack.dev/reference/events/tokens_revoked/),
[invalid_auth can also include access-policy failure](https://docs.slack.dev/reference/methods/auth.test/#errors).

### R9. Startup cannot get app identity from auth.test alone

**Targets:** `startup`, `fx-identity-mismatch`, `installation` in `px-data`.

The documented bot-token `auth.test` response supplies `team_id`, `user_id`
and `bot_id`, not `app_id`. It also does not validate that the separately supplied
Socket Mode token belongs to that same app.

**Fix:** use `auth.test` for bot/team identity, `bots.info(bot_id).bot.app_id`
for the bot's app, and verify Socket Mode `hello.connection_info.app_id` against
it before processing events or sending. The existing `users:read` scope supports
`bots.info`, so this needs no additional scope. Fail closed on mixed xapp/xoxb
credentials and test that exact combination.
[auth.test response](https://docs.slack.dev/reference/methods/auth.test/#response),
[bots.info identity and scope](https://docs.slack.dev/reference/methods/bots.info/),
[hello app identity](https://docs.slack.dev/apis/events-api/using-socket-mode/#connect).

### R10. Status needs a full lifecycle, not permanent disable on any refusal

**Targets:** `slack-feedback`, `outbound`, `s6`, `test-live`.

The no-container `assistant.threads.setStatus` choice needs the compatibility
qualification above. Setting it only once at `inbox` means a long job looks inactive
after two minutes, while disabling it for any error makes one 429 permanently
remove the feature. Status is scoped to the app/thread, not to an individual
request, so one request finishing can incorrectly clear another's status.

**Fix:** keep best-effort thread-level state with conservative refresh while
known work is active, and explicit clear on completion, failure, cancellation
and expiration. Handle 429/network errors as transient, and disable only after
a durable capability/permission refusal with a visible warning. Recompute
thread status if multiple requests share the same root. Do not let optional
status/reaction failure block final delivery. Rate-limit `reactions.remove`
separately: it is Tier 2 (20+/minute), not `reactions.add`'s Tier 3.
[Status contract](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/),
[remove-reaction limit](https://docs.slack.dev/reference/methods/reactions.remove/).

### R11. Align acceptance and manifest with the chosen v1

**Targets:** `outcome`, `slack-feedback`, `operator-docs`, `acceptance`,
`fx-file-hostile`, `s12`, `s13`.

Removing `files:write` is appropriate when uploads are excluded. The remaining
scopes cover replies, retraction, progress edits, files, metadata and reactions.
Keep the disabled Messages tab and do not add `assistant:write`.

The twelve-item research live checklist includes output uploads/images and
explicitly authorized Slack Connect tests that are not v1 requirements.
Acceptance should use its applicable subset and record deferred items rather
than requiring contradictory unsupported behavior. The opening also excludes
all editing while feedback requires editing progress. Say "final-answer editing
is excluded, progress-message updates are supported."

Finally, add a file deletion/retention test: `file_deleted` has no channel,
must purge only an indexed file, and is not emitted for retention expiry.
Keep the independent seven-day TTL and purge attachment caches on message
deletion/unlink, not only on file events.
[File-deletion shape/exception](https://docs.slack.dev/reference/events/file_deleted/),
[own-message edit contract](https://docs.slack.dev/reference/methods/chat.update/).

## Owner confirmation follow-up, 2026-10-28

The Toy Box analyst found that a shell-capable agent can manufacture a recent
"owner message" through Toy Box's unauthenticated HTTP endpoint, or unset its
session environment variable and become the CLI's apparent operator. The
thirty-minute owner-message gate is therefore a context signal, not independent
human authorization.

**Recommendation: explicit Approve/Reject buttons on a durable, bot-authored
control message in the linked Slack channel.** Authorize the click by the
already pinned owner's Slack user ID. Prefer this over a checkmark reaction:
buttons communicate exactly which change is being approved and require no new
OAuth scope. Prefer a normal control message over an ephemeral-only prompt:
Slack explicitly does not guarantee ephemeral delivery, requires an active
channel member, and removes ephemeral messages across sessions/reloads. If
configuration details should not appear in the channel, use an ephemeral
presentation with a durable local pending proposal and an explicit redisplay
path, not an assumption the owner saw it.
[Button action payload](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/),
[ephemeral delivery caveats and chat:write scope](https://docs.slack.dev/reference/methods/chat.postEphemeral/).

### Manifest delta

Buttons use the existing `chat:write` and Socket Mode connection. Enable
interactivity; no HTTP request URL, tunnel, signing-secret handler, DM scopes,
agent container, `reaction_added` subscription, or additional bot scope is needed:

```yaml
settings:
  socket_mode_enabled: true
  interactivity:
    is_enabled: true
```

Merge this fragment into `settings`, rather than replacing the other settings
in the app manifest. Interactive clicks arrive as Socket Mode `type:
"interactive"` envelopes with a `block_actions` payload. They do not have an
Events API `event_id`, so must not be sent through a parser that requires one.
The lead adopted this follow-up in the revised brief and `docs/manifest.yaml`.
The top-of-document manifest is now synchronized to that nine-scope v1.
[Manifest fields](https://docs.slack.dev/reference/app-manifest/#settings),
[Socket Mode interactive envelopes](https://docs.slack.dev/apis/events-api/using-socket-mode/#button).

The reaction alternative requires **both** `reactions:read` and the
`reaction_added` bot event. Existing `reactions:write` only covers adding/removing
the app's own reactions. Its human actor is `event.user`, not `item_user`.
It also needs a durable bot-authored proposal message, exact item timestamp,
expiration, one-use application and replay protection, so it does not save much
state machinery.
[Reaction subscription scope and actor](https://docs.slack.dev/reference/events/reaction_added/).

### Proposal and application contract

1. A CLI setup call proposes a fully validated change. Persist its opaque ID,
   exact immutable proposed configuration/hash, previous configuration revision,
   pinned owner/team, channel, expiry, creation source and pending state.
   Do not apply a widening change while waiting.
2. The bridge composes a narrow control card showing the before/after effect,
   actual user/channel identities, and Approve/Reject buttons. Button values
   contain only an opaque proposal reference, never executable configuration.
   This is a deliberate bridge-owned control-message exception to the
   "bridge only reacts and sets status" product rule.
3. Accept decisions only on the real Slack receiver path. Check `api_app_id`,
   installation/team, `user.id`, proposal ID, action kind, originating
   channel/message, expiry and expected configuration revision. The approval
   owner comes from existing pinned configuration, not from the untrusted new
   proposal's `--owner`. No CLI/RPC "approve" bypass should exist.
4. Commit the decision and configuration change atomically, recording the
   verified Slack actor. A repeated click or envelope is idempotent. Ack every
   envelope promptly after the durable decision. Do not fetch profiles or ask an
   agent in this path.
5. Update the control card asynchronously to applied/rejected/expired/stale.
   If a card send/update has an unknown outcome, the durable proposal remains
   authoritative. Expired, superseded and stale-revision approvals never apply.
   Throttle proposal creation so injection cannot flood the owner with prompts.

Initial owner pinning must happen through explicit human provisioning outside
the agent's untrusted configuration proposal. Changing that owner requires
approval from the **old** pinned owner, not self-approval by the proposed new
identity. A defined recovery procedure is needed if the old owner is unavailable.

**Boundary qualification:** this proves a genuine Slack-user decision to an
intact bridge. It does not sandbox an arbitrary same-OS-user shell that can
modify the bridge's SQLite database, process, credential file or source. Strong
independence still requires an agent-inaccessible bridge identity/data directory
or another real isolation boundary. Do not upgrade the trust claim merely
because a button was added.

Proof additions: owner versus non-owner click, stale hash/revision, expired and
replayed click, mismatched app/workspace/channel/message, config changed between
card and click, crash before/after decision commit, reconnect redelivery,
ephemeral nondelivery if that presentation is chosen, and rejection of a
local-RPC approval attempt. Live verification must confirm the new interactivity
setting in the actual workspace before claiming the owner gate is operational.

## Revised-brief follow-up, 2026-10-28

Review requested in channel message 30. The changes to durable commits,
confirmation-based answering, request input revisions, sharing flags,
installation identity, authentication failure, scoped recovery and status
handling landed substantially as intended. `docs/manifest.yaml` has the correct
nine bot scopes and fourteen event subscriptions, enables Socket Mode
interactivity without a request URL, disables the Messages tab, and excludes
`files:write`, `assistant:write` and `reactions:read`. The research manifest
above is synchronized to it. Slack's server-side validation and live acceptance
remain pending.

### F1. Field-level staleness is reasonable, but needs full dependencies

**Targets:** `px-approval`, `fx-click-stale`, `s8`.

I support avoiding a global configuration revision that invalidates unrelated
proposals. A compare-and-swap on just the changed field values is insufficient,
however. For example, an owner sees a resume card for a bot-removal suspension;
before the click, the private channel becomes public. The link still says
`suspended`, and general revalidation still permits a public channel, so the
old card can approve a wider audience that it never showed.

**Fix:** keep an immutable, scoped proposal read-set: its exact link identity,
write-field before values, pinned owner, monitored/publish destinations,
audience fingerprint, suspension reason, and other validation dependencies.
At application, compare these, revalidate, and apply **only the displayed
patch** atomically. An unrelated label change need not stale the proposal.
An audience/identity/lifecycle change must. Explicit pause/deny/unlink should
invalidate pending proposals that would reverse that action, even if the
value happens to equal the card's original before value. This covers the
false-to-true-to-false, or ABA, case without a global counter.

Reject any action ID except the two exact registered Approve/Reject actions.
The current pseudocode treats every non-`reject` action as approval. This is
unnecessary implicit permission and should be a strict typed union with tests.
[Slack action identity fields](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/#fields).

Do not perform Slack/Toy Box network validation inside the serial transaction
before the ack. If fresh validation is needed, durably record the owner's
decision, ack, asynchronously validate, then atomically compare/apply or mark
stale. Alternatively apply immediately only with already valid local evidence.
Neither path should hold the whole database queue behind remote API latency.
[Interaction acknowledgement budget](https://docs.slack.dev/interactivity/handling-user-interaction/#acknowledgment_response).

### F2. Reset is still a normal-service route around the pinned owner

**Targets:** `px-claim`, `px-cli`, `trust`, `fx-owner-gone`.

`reset --yes` is operator-only, but the brief correctly states that unsetting
`COPILOT_AGENT_SESSION_ID` becomes the operator. A steered lead can therefore
use the intact bridge's normal interface to clear the owner and reopen claim,
after which a different Slack person can claim. This is distinct from the
acknowledged residual risk of directly modifying bridge files or its process.

**Fix:** do not expose owner-clearing reset through the running bridge's RPC.
Retain owner transfer through approval by the old owner. Treat recovery without
that owner as explicit **offline destructive reprovisioning**, with the service
stopped, the exclusive lock held, a warning about lost configuration and a fresh
claim. Document that same-UID code can still stop/tamper with the service, which
remains outside the intact-service authorization guarantee. Test that changing
caller environment cannot clear the running installation's pinned owner.

### F3. The shared served_rev does not bind an answer to its read

**Targets:** `px-data.requests`, `px-cli`, `px-lifecycle`, `fx-stale-answer`, `s6`.

The revised design records `served_rev` when `inbox` or `thread` shows a
revision. `thread` is also available to members and the operator. If the lead
reads revision 1, revision 2 arrives, and a member reads the thread, the shared
`served_rev` becomes 2. A stale answer composed from revision 1 then passes a
`served_rev === input_rev` check. Even restricting that marker to the lead
would not bind concurrent/in-flight reply calls to a particular read.

**Fix:** return an immutable revision or read token to the lead and require it
on the mutation, for example `reply r14 --revision 2`. The outbox copies that
exact revision and compares it against current `input_rev` at enqueue and send.
Keep `served_rev` for attention/presentation if useful, not as the authority for
which content a particular answer consumed. Add the lead-read/edit/member-read/
stale-reply interleaving to the integration test.

### F4. Claim runs before the human-message guard

**Targets:** `px-claim`, `px-classify`, `s8`.

Claim is intercepted before normalization, while normalization is where the
brief establishes human eligibility. Its own contract must explicitly check
the authenticated installation/app, a real current-workspace human author,
exact bot mention and claim syntax, and absence of bot/app/self identity.
Do not claim ownership from an edit, backfill, broadcast copy or bot-generated
message that merely contains the code. Permit only one live code, consume it
atomically with the owner pin, and keep the five-attempt limit installation-wide
for that code.

A claim posted in an ordinary public channel is a bearer code visible to other
members. Do not rely on Socket Mode arrival order to prove who first supplied
it. For deterministic bootstrap, have the human provision the expected member
ID alongside generating the code, or require a final terminal confirmation of
the candidate Slack identity before pinning. This does not add a Slack scope,
but the bootstrap UI must be explicit about its local-trust assumption. A code
alone is proof of code possession, not proof of being the intended local owner.
[Socket Mode distribution has no promised order](https://docs.slack.dev/apis/events-api/using-socket-mode/#connections),
[message actor and optional subtype fields](https://docs.slack.dev/reference/events/message/).

### F5. Delivered resolution needs a concrete Slack message

**Targets:** `px-cli`, `outbound`, `s6`.

`resolve --delivered` currently accepts no message identifier. Merely declaring
delivery cannot satisfy "answered only when Slack confirmed it" and leaves no
canonical `slack_ts` for retraction or later reconciliation.

**Fix:** require a message permalink or exact channel/`ts`, fetch it, and verify
its app/bot ownership and intended channel/root. Store that evidence and actor.
If metadata is absent, distinguish an operator-attested content match from
cryptographic/correlation proof. Refuse a wrong message or a message the bridge
cannot verify. `--drop` and explicit duplicate-risk `--resend --yes` remain
separate actions.

### Follow-up closure

The brief revision announced in channel message 37 addresses F1–F5. I checked
`px-claim`, `px-approval`, `px-cli`, `px-lifecycle`, `outbound`, `trust`, the
relevant schema comments and the s6/s8 completion criteria. The immutable
revision argument, scoped approval read-set, decision/apply split, terminal
candidate confirmation, offline reset and identified-message resolution are
consistent with these recommendations. No further blocking issue found in
those changed sections.

Manual text evidence remains weaker than an outbox-metadata match, and terminal
checks do not isolate the bridge from arbitrary same-UID code. Both are now
explicit instead of being presented as stronger guarantees. This closes the
design review, not the implementation, protocol-fake or live-Slack proof.

## Enterprise deployment, verified 2026-10-28

This answers channel messages 79 and 85. **Recommend a dedicated, internally
created, workspace-installed app inside the Enterprise org, with same-org
multi-workspace channels supported and Slack Connect still refused.** Enterprise
membership and workspace installation are separate concepts. An org does not
force org-wide installation, and Socket Mode does not force a public endpoint.
GitHub's actual Slack topology, app policies, approved AI processing terms and
review process are **not verified** here. No credentials or real workspace were
used for this research.
[Installation options](https://docs.slack.dev/enterprise/organization-ready-apps/#why_prepare_for_enterprise),
[Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/).

### E1. Separate installation, delivery, account and audience identity

The current code uses `payload.user_team ?? payload.team ?? context.teamId`
as `SlackMessage.teamId`, then compares it to the installation in both
`classify` and `authorRole`. This rejects an admitted colleague from another
workspace in the same Enterprise org. Changing `user_team` to `source_team`
would not fix it. Those are different kinds of context, not company-membership
credentials.

| Surface | Verified meaning and recommended handling |
|---|---|
| `auth.test` | Bot responses identify `team_id`, `user_id` and `bot_id`; an Enterprise workspace also returns `enterprise_id`. Persist the latter as nullable installation identity, not as evidence about each author. The pinned SDK also models optional `is_enterprise_install`, `expires_in` and `app_id`. Do not require `app_id` from this response because its documented ordinary-bot example omits it. |
| `bots.info` | `bot.app_id` establishes the bot's app, and `bot.user_id` the bot user. `bot_id` is workspace-specific. A workspace token ignores `team_id`; an org token requires workspace/enterprise context. The existing `users:read` covers this method. |
| Socket Mode `hello` | `connection_info.app_id` identifies the app-level connection. The documented hello contains no workspace or enterprise identity. It checks the xapp/bot-app pairing, not which installation or person an event represents. |
| Events wrapper | `api_app_id` identifies the intended app. Outer `team_id` is event context and can differ from an installation's workspace in a shared-channel delivery. Preserve `context_team_id`, `context_enterprise_id`, optional outer `enterprise_id`, `is_ext_shared_channel`, `event_context` and the authorization tuple instead of treating outer team as the author's employer. |
| `authorizations` | Each entry describes an **app installation**, not the message author: nullable enterprise/workspace, authorized user/bot, `is_bot`, `is_enterprise_install`. `false` is normal for a workspace install inside an Enterprise org. Only one installation is included, not an exhaustive authorization list. A true `is_enterprise_install` means org installation, not merely an Enterprise customer. |
| Message `user` | The acting account. Resolve/store this independently from all team fields. An edit's actor/content belongs to the nested message, not a wrapper's user. |
| Message `team`, `user_team`, `source_team` | Slack describes `team` as the workspace where the event happens, `user_team` as the sending user's workspace, and `source_team` as the workspace from which the message originates. These may differ within one company, are not uniformly present, and do not establish Enterprise membership. Keep optional provenance separate, without inventing an author team when absent. |
| `block_actions.team` | The app's installation workspace. It is **null for an org-installed app**. Keep exact installation-team checking for the recommended workspace install. |
| `block_actions.enterprise` | The enterprise the installed app belongs to, whether workspace-installed in that org or org-installed. It is not proof the clicking account belongs to it. |
| `block_actions.user.id`, `user.team_id` | The human account and its workspace context. Do not equate that context with the installation workspace. A sibling-workspace owner can legitimately click. Approve only the exact pinned owner account, app, proposal, card and known action, as before. |

Sources for the table:
[auth.test](https://docs.slack.dev/reference/methods/auth.test/#response),
[pinned SDK response type](https://github.com/slackapi/node-slack-sdk/blob/a98047a7f27149812664c78e2dccfe4155b0e145/packages/web-api/src/types/response/AuthTestResponse.ts),
[bots.info](https://docs.slack.dev/reference/methods/bots.info/#usage-info),
[hello](https://docs.slack.dev/apis/events-api/using-socket-mode/#connect),
[event wrapper](https://docs.slack.dev/apis/events-api/#callback-field),
[Enterprise event examples and field meanings](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/#events_api),
[block_actions](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/#fields).

**Receiver routing needs a correction too.** The current
`eventCallbackSchema.team_id` description says "the installation's team, even in
a shared channel". Slack's own Enterprise example has outer team T1 but an
authorization for T2. A maintainer also documents this exact distinction.
For a dedicated app with only one supported workspace bot installation, match
the app plus its `is_bot:true`, workspace-level authorization tuple against the
pinned team/bot user and enterprise, rather than filtering exclusively on outer
team. Never use `authorizations.user_id` as the human actor. On event types with
no authorizations, retain the documented event-specific workspace check.
[Enterprise example](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/#events_api),
[Slack maintainer explanation](https://github.com/slackapi/bolt-python/issues/1107),
[revocation is one event with its own wrapper-team contract](https://docs.slack.dev/reference/events/tokens_revoked/).

If the same app is installed in additional workspaces, a single nonmatching
authorization is not proof our pinned installation lacks access, because the
list is truncated. Either make that multi-install topology explicitly
unsupported with a visible diagnostic, or resolve the full installation list
using `apps.event.authorizations.list` **after** durable receipt/ack. That
requires app-level `authorizations:read`, in addition to `connections:write`,
not a new bot scope. Do not add a remote authorization request inside the ack
transaction. The method is cursor-paginated and not every event has
`event_context`.
[Authorization enumeration and scope](https://docs.slack.dev/reference/methods/apps.event.authorizations.list/).

**Receiver handoff clarification (message 91).** Match `api_app_id` on every
callback. Route `app_uninstalled` and `tokens_revoked` by their documented outer
`team_id` contracts before the generic authorization rule. The uninstall
reference explicitly includes an `is_bot:false` authorization, so requiring our
bot tuple there would lose a real uninstall.
[Uninstall payload and workspace meaning](https://docs.slack.dev/reference/events/app_uninstalled/),
[revocation payload and workspace meaning](https://docs.slack.dev/reference/events/tokens_revoked/).

For ordinary authorized events, the proposed `is_bot:true`, pinned team and
pinned bot-user match is correct for the declared single-install deployment.
Also refuse an explicit `is_enterprise_install:true`, and reject any supplied
enterprise identity that contradicts the pinned installation. Do not require
optional fields merely because the newest example includes them. An explicitly
empty, nonmatching or malformed authorization array must never become the
"authorizations absent" wrapper-team fallback. Limit that fallback to supported
event types whose reference establishes the relevant workspace contract, not
unknown events. Test absence separately from empty/nonmatching arrays.
[Installation tuple and forward-compatible fields](https://docs.slack.dev/apis/events-api/#callback-field).

Make "dedicated app installed in exactly one workspace" an explicit deployment
prerequisite, not a conclusion drawn from a nonmatching tuple. Persist/ack the
receipt and log an authorization mismatch as a possible unsupported topology,
not proof that our install lacks access or that a second install exists. Clicks
retain exact app and `team.id` checks; a null team is explicitly unsupported
org-installation input, not a reason to compare the clicking person's team.
[Truncated authorizations](https://docs.slack.dev/apis/events-api/#event-type-structure),
[interaction installation team](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/#fields).

#### Admission-time checks, then exact IDs on the message path

The lead's message 85 is the simpler recommendation. The official
`users.identity` reference explicitly says **"User IDs are now globally
unique"**, and that the same person in unrelated workspaces has different IDs.
Enterprise documentation says one global U/W ID identifies a person across
the Enterprise org. **I did not find an explicit promise that IDs are never
reassigned over all time**, so do not claim that stronger lifetime guarantee.
The general user-object page still recommends storing workspace and ID
together. Partition cached identities and grants by our pinned installation,
while treating a Slack-supplied Enterprise alias as the same account only when
Slack establishes the mapping.
[Global uniqueness](https://docs.slack.dev/reference/methods/users.identity/#response),
[Enterprise global IDs](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/#user_ids),
[user ID and enterprise_user fields](https://docs.slack.dev/reference/objects/user-object/#fields).

Recommended admission contract:

1. At terminal claim confirmation, `allow` apply and owner transfer, fetch
   `users.info` outside the database queue. `users.list` is insufficient: Slack
   explicitly says it may omit sibling-workspace users. Resolve the name for
   display, but authorize with IDs. Reject unknown, deactivated and bot accounts,
   including special Slackbot.
2. With a pinned Enterprise ID, require
   `user.enterprise_user.enterprise_id === installation.enterpriseId`. With a
   standalone workspace, require the resolved account's `team_id` to equal the
   installation's team. Missing affiliation is unverified, not local by default.
   If a legitimate Enterprise response lacks the required fields, refuse with
   a clear diagnostic instead of guessing. `is_stranger:false` is not proof of
   local membership.
3. Store the resolved canonical user ID, any returned root-ID alias, verified
   enterprise/workspace affiliation, bot/deactivated state and verification
   time. Prefer `enterprise_user.id` when present. Migration aliases must come
   from Slack, never matching names or email.
4. On messages, match owner/allowlist by those exact admitted IDs. Remove
   `other_team` as an authorization rule and the team-equality early return in
   `authorRole`. Preserve optional message-team fields only as provenance.
   Unknown people remain observed and never become requesters from a missing
   team field. No per-message `users.info` or new-user lookup is needed.
5. Claim interception still consumes every code-shaped message before content
   storage. It may record the raw candidate ID from an eligible live human
   message without requiring the author's team to equal the installation.
   **The terminal must verify affiliation before offering confirmation/pinning.**
   A correct bearer code from an external account must not establish ownership.
6. Exact-ID matching does not prove current membership forever. Reverify the
   small admitted-user set at startup/reconnect and periodically outside the
   queue. `user_change` can invalidate cached membership/deactivation evidence
   using existing `users:read`, with startup/periodic refresh covering missed
   events. A changed installation Enterprise ID or ID-translation/migration
   signal should hold execution for explicit revalidation, not silently rewrite
   grants. Choose and document the bounded-staleness interval. This is not a
   lookup on each message.

[Cross-workspace lookup and actions](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/#handling_unknown_users),
[users.info and scope](https://docs.slack.dev/reference/methods/users.info/),
[user fields and is_stranger meaning](https://docs.slack.dev/reference/objects/user-object/#fields),
[user_change](https://docs.slack.dev/reference/events/user_change/),
[migration.exchange](https://docs.slack.dev/reference/methods/migration.exchange/),
[migration outages](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/#migration).

An Enterprise member or workspace guest is not necessarily a company employee.
Slack exposes guest flags, not an HR employment attestation. Recommend full
members only for initial owner/admission unless the product explicitly supports
owner-approved guests. The reviewer must decide this policy. The same-company
test must not be a claim that contractors are employees.
[Guest flags](https://docs.slack.dev/reference/objects/user-object/#fields).

**Does the current code accept outsiders?** Missing team provenance alone does
not let an arbitrary stranger open a request: exact owner/allowlist checks still
apply. It does mean the fallback cannot prove the asserted affiliation, and a
claim must not rely on it. Observed text from unapproved people inside a request
thread is intentionally retained under the existing policy, so it can still
reach the model as context. Bot/channel membership and approved-channel policy
remain independent gates. Admission checks must apply equally to owner, allow
and transfer, not only to `allow`.

### E2. Org-shared is internal, not Slack Connect

**Change the current blanket ban on `is_org_shared`.** Slack distinguishes:

| Current channel facts | Recommended v1 outcome |
|---|---|
| `is_ext_shared` or `is_pending_ext_shared` | Refuse link/resume and hold existing output. External or pending external sharing remains unsupported. |
| `is_org_shared`, no external/pending flag | Permit within the pinned Enterprise org, with explicit audience shown on the approval card. Do not infer external sharing from `is_shared`. |
| A linked channel gains another internal workspace or changes private/public kind | Hold and require fresh owner approval because audience widened, even though it remains in-company. |
| Sharing state or audience cannot be established | Hold with an explained unverified state, not an implicit internal classification. |

`is_shared` deliberately includes both internal multi-workspace and external
sharing. Store separate external, pending and org flags. Add the sorted
`shared_team_ids`/available internal-workspace set, `enterprise_id` and
`context_team_id` to cached channel facts and the approval audience fingerprint.
A boolean org flag alone cannot detect another internal workspace being added
to an already org-shared channel. These sets describe workspace topology, not a
complete frozen roster of individual readers.
[Conversation booleans and attributes](https://docs.slack.dev/reference/objects/conversation-object/#booleans),
[Slack Connect's explicit is_shared warning](https://docs.slack.dev/apis/slack-connect/#is_shared).

Keep the initial safety hold on `channel_shared`, invalidate cached facts and
refresh before resuming. Its current event reference describes an **external**
workspace join, and `connected_team_id` may even be an Enterprise E ID. Do not
decide company membership from that ID's prefix or assume the event is a
complete feed of internal audience changes. Periodic/reconnect channel refresh
must detect the latter. If refreshed facts prove the audience exactly unchanged,
the temporary verification hold can clear. A real audience change requires the
normal approval path. No auto-resume just because sharing is internal.
[channel_shared](https://docs.slack.dev/reference/events/channel_shared/),
[Enterprise shared-channel types](https://docs.slack.dev/enterprise/#shared-channels).

**Brief/code surfaces:** `fx-shared`, `px-approval.Audience`, `channel_info`,
startup/link/resume capability checks, `audienceChange`, send-time checks and
the corresponding channel/parser fixtures. This changes no bot OAuth scope.

### E3. Installation and approval

**Ordinary app approval still applies to an internal Socket Mode app.** An Org
Owner can enforce approval across workspaces. Workspace Owners/app managers
handle their requests unless org policy resolves the app. Approval reviews the
requested scopes. Later scope increases can require new approval. Being an app
collaborator or a channel owner is not equivalent to being an app approver.
[Workspace approval](https://slack.com/help/articles/222386767-Manage-app-approval-for-your-workspace),
[org policies](https://slack.com/help/articles/360038559694-Set-organization-level-policies-for-apps),
[org app management](https://slack.com/help/articles/360000281563-Manage-apps-in-an-Enterprise-organization).

**Correction to channel message 78:** Marketplace-only is not automatically a
blocker. Slack's settings documentation explicitly says this setting **"will
not prevent members from creating and installing internal apps."** Socket Mode
apps cannot currently list publicly in the Marketplace, but a genuinely
internally created app has this documented path. Create a separate
company-owned app inside the target work workspace rather than distribute the
personal test app into it. Confirm how GitHub classifies/approves that app.
The org-policy article does not separately spell out every internal-app
exception, so do not promise an org administrator's exact UI or GitHub-specific
override from the workspace-setting article alone.
[Internal-app exception](https://slack.com/help/articles/1500009181142-Manage-app-settings-and-permissions),
[Socket Mode restriction](https://docs.slack.dev/apis/events-api/using-socket-mode/),
[Internal versus Distributed source](https://slack.com/help/articles/360000281563-Manage-apps-in-an-Enterprise-organization).

**Keep `org_deploy_enabled:false` for v1.** Workspace installation within an
Enterprise org is officially supported for this app class. Org-wide deployment
is a different product scope: one token can represent several granted
workspaces, installation may return `team:null`, some methods need explicit
team selection, and workspace grants/revocations have their own events.
It is not necessary to add admin/SCIM/Discovery scopes for our use case.
Reject `is_enterprise_install:true` credentials with an actionable diagnostic
rather than accidentally interpreting them as a normal workspace installation.
If GitHub requires org-only deployment, that is a real additional implementation
requirement, not a manifest toggle to turn on before testing.
[Installation options and token model](https://docs.slack.dev/enterprise/organization-ready-apps/),
[org OAuth payload and method context](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/#oauth),
[grant/revocation events](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/#new).

Admin policy can also restrict **who can use an app** and **which channels the
app may enter**. Slack currently labels the channel-access control as rolling
out gradually. Approval and bot invitation therefore do not alone prove every
intended channel is usable. Treat refusals as policy/access errors and never
attempt another credential or alternate transport to bypass them.
[Member and channel app permissions](https://slack.com/help/articles/360000281563-Manage-apps-in-an-Enterprise-organization).

Corporate egress proxies/VPNs and token IP allowlists can affect a laptop bridge.
Slack documents IP policy rejection as `invalid_auth`, another reason not to
purge on that error. Validate WebSocket/API access through approved networking,
without disabling TLS validation or exposing Toy Box publicly.
[Token network restrictions](https://docs.slack.dev/concepts/security/#restrict-ip-addresses).

### E4. Rotation is supportable, but not transparently crash-proof

**If token rotation is required, the current static-token bridge is not ready
for that installation.** Enterprise policy can require OAuth token rotation
and expire unused refresh tokens after **30 days**. Slack says these policy
changes apply to installations/updates after the setting is enabled, not
retroactively to all existing apps.
[Org token-rotation policy](https://slack.com/help/articles/360038559694-Set-organization-level-policies-for-apps).

Verified protocol:

- Turning on bot/user token rotation cannot be undone. Access tokens expire in
  43,200 seconds (12 hours); honor each response's `expires_in`.
- Provision an access/refresh pair through OAuth. Existing long-lived tokens
  can be exchanged **once** with `oauth.v2.exchange`, supplying the app's client
  ID and client secret. Do not revoke the old long-lived token yourself as an
  exchange cleanup step.
- Refresh with `POST https://slack.com/api/oauth.v2.access`,
  `grant_type=refresh_token` and the current refresh token. Client ID and secret
  authenticate the app; the method recommends HTTP Basic authentication rather
  than logging them as ordinary request parameters.
- Every successful refresh returns a **new access token and new refresh token**.
  Persist both together. Refresh tokens are one-use. The guide mentions a
  **short grace period** before revocation, but gives no duration or recovery/
  idempotency guarantee. Do not promise that retrying an old token returns the
  same replacement pair.
- An existing access token is not immediately invalidated by refresh, but at
  most two access tokens may remain active. Repeated refreshes can revoke the
  oldest. This is not a license to run parallel refresh loops.

[Rotation lifecycle](https://docs.slack.dev/authentication/using-token-rotation/),
[exchange and token_already_exchanged](https://docs.slack.dev/reference/methods/oauth.v2.exchange/),
[refresh arguments and client authentication](https://docs.slack.dev/reference/methods/oauth.v2.access/).

**Current app-level token nuance:** docs now also support separately opted-in
rotation for Socket Mode app-level tokens. Manifest
`settings.app_level_token_rotation_enabled:true` controls this separately from
`token_rotation_enabled`. New rotating tokens use `xoxe.xapp-`, expire in 12
hours and use their own refresh chain; existing app-level tokens created before
opting in remain non-expiring. A lost app-level token pair requires creation of
a new app-level token. Do not assume bot rotation automatically rotates the
existing xapp, or that every Enterprise policy requires both settings. No
effective date for this app-level addition was found on the current reference.
[App-level rotation](https://docs.slack.dev/authentication/tokens/#app-level-rotation),
[manifest setting](https://docs.slack.dev/reference/app-manifest/#settings).

Recommended minimal credential manager:

1. Provision client ID, client secret, token kind, app/workspace/enterprise and
   bot identity, access token, refresh token, acquired time, expiry and a local
   generation. Keep secrets in a bridge-owned secure store, never in CLI
   results, ordinary audit/log payloads, the model environment or the repo.
   Protect the response pair and rotation state with the same full-durability
   storage contract. A Mac Keychain-held encryption key can protect a dedicated
   credential record, but encryption does not isolate a same-UID agent.
2. Exactly one worker may refresh a token chain. The exclusive bridge lock
   provides one-process ownership; an in-process single-flight/generation check
   prevents concurrent callers from starting another refresh. Bot and optional
   app-level chains are separate. Disable SDK transport retries for refresh.
3. Refresh conservatively before expiry, for example one hour early with
   jitter. First commit a non-secret `refreshing` intent naming the generation.
   Make the HTTP request outside the database queue. On a validated success,
   durably replace access token, refresh token, expiry and generation in one
   transaction **before publishing the new token to callers**. Never save only
   the access half.
4. Web API calls obtain the current committed bot token, not a constructor's
   forever-static original. App-level refresh updates credentials used for the
   next `apps.connections.open`; do not tear down a healthy socket solely to
   rotate. The old access token remains usable until expiry/revocation, but a
   failed refresh must be visible well before that.
5. Handle explicit 429s with persisted Retry-After. A response timeout/reset,
   crash while `refreshing`, or failure to durably save a received replacement
   is **rotation_unknown**, not a safe automatic refresh retry. Preserve
   evidence and explain reauthorization/reprovisioning. Do not repeatedly
   redeem the uncertain old refresh token.
6. `invalid_refresh_token`, expiration after extended downtime and missing
   replacement credentials enter a repair-required state. Stop using expired
   tokens, hold publication and preserve settings/content under the chosen
   authentication-failure retention policy. OAuth reauthorization repairs a bot
   chain; app-level reprovisioning repairs the connection chain. Recheck the
   installation identity before resuming.

Steps 1-6 are our design recommendation, not an SDK-provided atomicity guarantee.
Slack and SQLite cannot share a transaction. If Slack consumes the refresh token
but the replacement response is lost before durable storage, **fully automatic,
lossless recovery cannot be guaranteed from the documented API**. A short grace
period may help in practice but is not a provable crash-recovery mechanism.
The minimal correct product is fail-closed with a clear operator recovery path,
not "rotation can never interrupt service". Reauthorization need not uninstall
the app or destroy bridge state.

**Change revocation handling before enabling rotation.** Slack explicitly says
`auth.revoke` on a rotating app revokes one token **without uninstalling the
underlying installation**; events can continue. `tokens_revoked` identifies bot
user IDs, not token generations. Therefore a matching bot-user revocation is no
longer sufficient evidence to purge the installation. For rotating installs,
hold/revalidate the current chain and treat a confirmed uninstall separately.
Do not delete all content because an older access generation was revoked.
Whether every refresh/expiry produces that event is not promised by the event
reference and must not be assumed.
[Rotating-token revocation semantics](https://docs.slack.dev/authentication/using-token-rotation/#uninstall),
[revocation payload](https://docs.slack.dev/reference/events/tokens_revoked/).

Before that manager exists, setup/doctor should explicitly refuse supplied
rotating credentials instead of working for twelve hours and then failing.
Never enable rotation in the manifest or app UI merely to pass review first.
Secret detection/redaction also needs the rotating `xoxe.xoxb-`, `xoxe.xapp-`
and refresh-token formats, and must not dump OAuth response bodies on errors.

### E5. Reviewer questions and the limits of local copies

This is a reviewer checklist grounded in Slack's published recommendations, not
a claim about GitHub's private process. A small app does not inherit Slack's own
AI or Marketplace security guarantees. A custom Socket Mode app has not passed
Marketplace review just because its scopes are approved.
[Slack's admin review questions](https://slack.com/help/articles/360001670528-Security-recommendations-for-approving-apps),
[Marketplace review scope and limits](https://docs.slack.dev/slack-marketplace/marketplace-terms-conditions/slack-security-review/).

| Reviewer question | Already in our design | Remaining approval or evidence gap |
|---|---|---|
| What does it read and why? | Nine justified bot scopes, only linked channels retained, no DMs/admin/SCIM/Discovery, default requester filtering, no autojoin. | Explain that bot OAuth capability/membership can be broader than local filtering, and that unallowlisted thread context can reach the model. Confirm the exact approved channels and permitted private content. |
| Where does data go? | Outbound Socket Mode, loopback Toy Box, intentional Slack publication, disclosed model use. | Name the actual Copilot account/plan, selected model providers/subprocessors, processing regions, retention, support access and contractual no-training terms. "Copilot-only lead" alone does not establish these. |
| Who can act or widen access? | Explicit IDs, terminal-confirmed owner, Slack-authenticated approval, immutable read-set, audited narrowing, revision-bound output. | Enterprise admission/audience changes above, guest policy, account removal response and prompt-injection scenario proof. Model instructions are not an execution sandbox. |
| How are copies secured/deleted? | 0700 folder, 0600 socket, FileVault check, local retention/purge and file TTL. | Include SQLite/WAL, backups/snapshots, downloaded files, generated reports, Toy Box session/tool transcripts, conversation context and provider copies. Deleting the bridge ledger cannot erase already-consumed model context. Prove the actual deletion boundary rather than promising end-to-end purge. |
| How is it operated? | Exclusive lock, commit-before-ack, cooldowns, no blind post retry, coverage/error visibility. | Company-owned app collaborators, maintenance and incident contacts, approved Mac/MDM/network/secrets storage, rotation, dependency updates, offboarding and a supported disaster-recovery path. |
| Is the host an adequate trust boundary? | Same-UID/local-process limitation is explicit. | GitHub may require an isolated bridge account, sandbox/managed host or stronger Toy Box auth. FileVault and Unix file mode do not protect bridge secrets from a shell-capable agent with the same UID. |

Slack's Developer Policy, effective **December 10, 2024**, requires proper
consent, strong encryption, disclosed necessary scopes and an accessible
privacy policy, prohibits training LLMs on Slack data, and requires deletion
within fourteen business days after app deletion/discontinuation. It also
forbids encouraging users to bypass employer policies. The reviewer should
approve the actual inference data-processing arrangement; this research is not
a legal determination that any chosen provider contract meets it.
[Developer Policy](https://docs.slack.dev/developer-policy/),
[Slack's AI-app data/security guidance](https://slack.dev/data-security-best-practices-for-agentic-slack-apps/).

**EKM.** Slack EKM encrypts covered data inside Slack and explicitly includes
apps running on Slack's managed infrastructure. Our local bridge is not that
infrastructure. Its downloaded plaintext, SQLite records and model transcripts
are separate copies that cannot be presumed to be revoked by a Slack key
change. Slack exposes `ekm_access_denied` redaction and may return that Web API
error. The redaction actor can be virtual `UREVOKEDU`, which cannot be resolved
with `users.info`.
[EKM coverage](https://slack.com/help/articles/360019110974-Slack-Enterprise-Key-Management),
[redaction subtype](https://docs.slack.dev/reference/events/message/ekm_access_denied/).

Treat an observed redaction as an access withdrawal, not ordinary new human
content or evidence that repair is complete. Purge/withhold affected cached text
and files, prevent stale output and mark pending sources unverifiable. A
redaction can refer to an old message: its lack of a newer edit timestamp must
not cause the merge to keep the prior text. Current `mergeSnapshot` would
preserve a same-version stored hash when the incoming snapshot merely drops
content, so normalization/merge need an explicit access-withdrawal path. Do not
promise a complete push feed of all EKM revocations or retroactive deletion of
what the model already read. If that promise is mandatory, this architecture
needs a different data/control design before deployment.

**DLP.** Slack's native DLP can alert, warn or hide/tombstone messages/files;
its documented exclusions include non-text files and several other surfaces.
It does not establish a guaranteed synchronous pre-export gate for this bridge.
An event can reach us before a later administrative action, and a local secret
regex is not an enterprise DLP system. Handle subsequent hide/delete/refusal
without continuing to use a retained copy, and obtain approval for the remaining
timing gap and model exposure.
[Native DLP actions and exclusions](https://slack.com/help/articles/12914005852819-Slack-data-loss-prevention).

**Retention and legal hold.** Slack retention and legal-hold settings describe
Slack's storage, not our database, Toy Box transcripts or provider retention.
Legal holds preserve certain Slack content despite ordinary edits/deletions and
expose it through exports/Discovery; their coverage has explicit exclusions.
The bridge is not a compliance archive and lacks a hold/export integration.
Do not silently turn off our deletion policy to approximate legal hold or claim
that a Slack hold automatically preserves/deletes our copies. Ask the designated
legal/compliance owner whether a short-lived operational copy is permitted and
how preservation requests reach its operator. Block a corporate rollout if the
required local-copy obligations conflict with our implemented retention.
[Legal holds](https://slack.com/help/articles/4401830811795-Create-and-manage-legal-holds),
[Slack data residency applies to specified Slack-held data](https://slack.com/help/articles/360035633934-Data-residency-for-Slack).

**AI-specific channel controls.** Current Slack documentation also describes
channel AI-use restrictions and gradually rolling-out app/channel access
permissions. The former page discusses Slack search/Slackbot/canvas AI; do not
assume it universally blocks a custom Events API bot. The latter can restrict
our app's channel placement. Honor actual denials, get explicit approval for
every selected channel, and do not treat successful API access as evidence the
company approved AI processing.
[AI-use restriction scope](https://slack.com/help/articles/47421816860947-Restrict-AI-access-to-certain-channels-canvases-and-lists),
[app/channel access controls](https://slack.com/help/articles/360000281563-Manage-apps-in-an-Enterprise-organization).

### E6. Recommended brief changes, in corporate-rollout priority

| Priority | Change | Is this a GitHub install blocker? |
|---|---|---|
| 1 | Approve the internal app, exact scopes/channels, model-processing path and host/data-copy policy. Name the responsible admin/security/privacy owner. | **Potential hard policy blocker.** Actual GitHub rules and approvers are unknown. Do not deploy first and ask later. Marketplace-only by itself is not proof of a block. |
| 2 | Implement E4's credential manager and recovery contract if OAuth/app-level rotation is required. Separate rotating-token revocation from uninstall/purge. | **Hard feature blocker if required.** Otherwise the nonrotating test deployment can proceed. |
| 3 | Add Enterprise ID and installation type, use admission-time verified accounts plus exact IDs, fix authorization-tuple routing and test sibling-workspace claims/requests/clicks. | **Correctness blocker for Enterprise use**, not a Slack install-dialog restriction. |
| 4 | Permit verified org-shared channels, persist/compare their workspace audience, retain the external/pending-external ban and owner reapproval. | **Channel-usability blocker** if the selected work channel is multi-workspace. |
| 5 | Add access-withdrawal handling and accurately scope retention/erasure beyond the bridge. Obtain acceptance for EKM/DLP timing and external model copies. | **Potential security/privacy blocker**, depending on required controls. |
| 6 | Keep workspace-only v1. Reject org-installed credentials and document the explicit supported topology. | **Hard scope blocker only if GitHub mandates org deployment.** Do not imply all Enterprise customers mandate it. |

Minimum new tests for those changes:

- A T1 workspace installation with enterprise E accepts an admitted global
  account from T2 in E, through message, terminal claim, allow and owner click.
  Missing `user_team` does not authorize an unknown account. A foreign-E
  account, deactivated account and disallowed guest cannot be admitted.
- A wrapper naming T1 with an authorization for our T2 installation routes
  correctly. A wrong app/bot authorization does not. Truncated nonmatching
  authorizations are distinguished from a proven foreign event. Null interaction
  team/org-install credentials are handled explicitly rather than crashing.
- Both U- and W-prefixed IDs and verified local/global aliases match. Different
  people with the same display name never do. Startup/migration invalidation
  holds stale grants without per-message API calls.
- Internal org sharing is permitted, external/pending sharing is not, and adding
  a workspace to an already org-shared audience stales an old approval.
- Each rotation chain has one refresh in flight. Success commits the full pair
  before use. Kill before request, lose the response, kill after receipt but
  before commit, fail disk persistence, return 429, revoke an older generation
  and restart after thirty days. Every uncertain outcome is visible and never
  silently purges or retries a one-use chain.
- An old same-ts EKM redaction removes cached content/files and holds a queued
  answer. Ordinary stale snapshot replay cannot resurrect it. A native DLP-style
  hide/delete is not reinterpreted as permission to use our older copy.

These are source-grounded acceptance recommendations. Free-workspace protocol
fakes can exercise their state machines, but cannot prove Slack's real
Enterprise payload variants or GitHub's policies. No Enterprise sandbox was
created. An approved Enterprise test environment remains required before
claiming Enterprise compatibility.
[Slack's Enterprise testing guidance](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/#sandbox).

**Local characterization:** a credential-free Bun invocation against the current
`normalizeHistoryMessage`, `authorRole`, `classify`, `readFrame` and
`mergeSnapshot` confirmed all three code-specific observations: an allowlisted
T2 author is stored as observed/rejected as `other_team` by a T1 installation;
the callback parser drops the authorization tuple; and same-version content
removal alone leaves a cached snapshot intact. These are local contract checks,
not observed Enterprise workspace behavior.
