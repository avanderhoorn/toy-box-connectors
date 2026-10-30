# Slack app review

toy-box-slack is one local Bun bridge between one Slack workspace and Toy Box.
A link watches one Slack channel, answers allowed people in its threads, posts
there when the owner asks, and publishes opt-in scheduled updates in that same
channel. A Copilot lead reads
the bridge's ledger and queues posts through a CLI.

**Review status:** this is a reviewer guide, not a compliance attestation or
deployment approval. The checks below must pass against the landed code.
Real Enterprise payloads and the company's private app and AI-processing
policies still need approval. [Platform research](research/slack.md#enterprise-deployment-verified-2026-10-28)
records the evidence and its limits.

## Slack access

Use a company-owned internal app installed in exactly one workspace and invite
its bot only to approved channels. The [manifest](manifest.yaml) requests eight
bot scopes:

| Scope                                                                                     | Purpose                                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`channels:history`](https://docs.slack.dev/reference/scopes/channels.history/)           | Receive public-channel messages and read history and threads.                  |
| [`channels:read`](https://docs.slack.dev/reference/scopes/channels.read/)                 | Check public-channel membership, archive state and audience.                   |
| [`groups:history`](https://docs.slack.dev/reference/scopes/groups.history/)               | The same message access in private channels the bot has joined.                |
| [`groups:read`](https://docs.slack.dev/reference/scopes/groups.read/)                     | Check those private channels and their audience.                               |
| [`users:read`](https://docs.slack.dev/reference/scopes/users.read/)                       | Resolve names, check admission and identify the installed bot. No email scope. |
| [`chat:write`](https://docs.slack.dev/reference/scopes/chat.write/)                       | Post answers, publications and posts the owner asks for, and retract its own.  |
| [`metadata.message:read`](https://docs.slack.dev/reference/scopes/metadata.message.read/) | Confirm a possibly delivered post by its outbox metadata.                      |
| [`reactions:write`](https://docs.slack.dev/reference/scopes/reactions.write/)             | Add eyes once the bridge wakes the lead for a request, or inbox serves it.     |

[Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) also
needs an app-level token with `connections:write`. Connections are outbound
HTTPS and secure WebSockets. There is no public Request URL, interactivity,
autojoin, user token, impersonation, file download, DM access, admin, SCIM,
Discovery, search or `chat:write.public` scope.

**The token is broader than our filter.** Its Slack permissions are not limited
to linked channels or allowlisted authors. The bridge discards unlinked message
content before storage, but that does not restrict a stolen token.

The default `--observe requesters` retains text from allowed people, our bot and
any person posting in a request thread. Other messages become content-free
markers. Opt-in `--observe channel` retains other people's channel text too.
Other bots' text is not retained. The allowlist controls who opens requests,
not whose words reach the model or who can read the Toy Box transcript.

## Copies and consent

| Destination                           | Data and purpose                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `~/.toy-box-slack` by default         | `bridge.db` and its WAL hold retained message text and change records, requests, names and IDs, link settings, allowlists, wake runs and queued output. Credentials are separate. No attachments are stored. |
| Local Toy Box                         | CLI output enters the lead's session transcript. The lead may post digests or create workspace files. The bridge never posts into Toy Box.                                                                   |
| Copilot and the chosen model provider | Whatever Slack text and tool output the lead reads can enter model requests. Copilot-only does not specify processing region, retention or contractual training restrictions.                                |
| Slack                                 | Thread answers, posts, publications and eyes reactions. No progress notes or answer edits.                                                                                                                   |
| Host backups and diagnostics          | Snapshots, copied reports and support bundles can become additional copies. Approve access and retention before enabling them.                                                                               |

Name the actual Copilot account and plan, permitted models and providers,
subprocessors, processing regions, retention and support access before approval.
Tell affected users about export from Slack, including unallowlisted thread
context. Do not use production content in tests or incident reports without
approval.

Slack's [Developer Policy](https://docs.slack.dev/developer-policy/), currently
dated December 10, 2024, prohibits training an LLM on Slack data and requires
consent, necessary scopes, strong encryption, an accessible privacy policy and
deletion within 14 business days of app deletion or discontinuation. **This
guide is not that privacy policy or a legal determination that a provider
arrangement complies.**

## Who can act

Requests match exact Slack user IDs, including established Enterprise aliases,
never display names or the workspace named on a message. Only allowed people
open requests. Normally they mention the bot or follow up in their request
thread. `--requests all` also accepts their top-level posts without a mention.
Bots, apps and messages from before the link never open requests.

Admission requires fresh account facts and refuses guests, bots, deactivated
accounts and people outside the installation's workspace or Enterprise org.
This is an admission-time check,
not an hourly account monitor. A later guest conversion does not automatically
remove someone, so the owner must review the allowlist. Scheduled digests and
publications are opt-in routines, not arbitrary authors' requests.

`link`, `allow` and `resume` run only for a caller with no Copilot session,
taken to be the owner at a terminal, and every `link` does, including a
narrowing change. A lead's or member's session is refused. Each applies at
once and answers with what it changed, in names from Slack, and `deny`,
`pause` or `unlink` reverses it. Like every caller role, this stops a lead's
mistakes, not a lead that unsets its session variable, so a lead steered by
Slack text could widen access that way. The skill tells leads never to run
these commands, but that is a prompt rule, not an enforced boundary. There
are no Slack approval buttons.

Only a linked channel's lead can reply, post or publish. A terminal can
inspect status but cannot answer as the lead. Member sessions are refused,
including reads. The skill's instruction to seek the owner's approval for
consequential work is a prompt rule, not an execution sandbox. The bridge
checks where a post goes and what it says, but not why the lead posts, so
posting only when the owner asks in Toy Box or a routine's prompt says to is
a prompt rule too.

Channels shared within the pinned Enterprise org are eligible only with a
known, approved workspace audience. Fresh channel checks at link, resume and
before every post compare against what the owner approved, not the last
refresh. Link and resume refuse archived channels. External sharing, a widened
audience, private-to-public conversion,
archive, a new channel ID, bot removal or an applicable policy refusal suspends
the link. A failed fresh read does not authorize sending. These checks cannot
make a send atomic with Slack's next channel change. When link or resume
approves a wider audience than before, the replies, posts and publications
the link held queued fail in that transaction rather than post to readers the
lead didn't write for, and each reply's request returns to the lead. One
already sending, or whose delivery is unknown, stays, since it may have posted.

There is no audience refresh at startup or before catch-up. A change missed
while offline can let text from a changed channel enter the ledger and model
context before a later send or resume discovers it.

## Host and output boundary

One owner on one Mac is the trust model. The data folder must be 0700,
`credentials.env` must not be group/world accessible (use 0600), and the socket
is 0600. The database, WAL and lock need not individually be 0600 because
the folder protects them. Token and URL environment variables override the
credential file. The published CLI loads no `.env` or `bunfig.toml` from the
folder it runs in.

`serve` reads a missing token only at the owner's terminal, without echo, and
saves it only in `credentials.env`. Tokens then stay in the bridge's normal
control flow, not CLI output or a lead's prompts.
The bridge opens no TCP listener and accepts only loopback HTTP for Toy Box.
**Toy Box has no authentication. Run `toy-box --host 127.0.0.1` and never
expose it publicly or through a tunnel.**

A shell-capable lead running as the same OS user can read credentials, edit
the database, forge caller identity or replace bridge code. Nothing in the
bridge protects a compromised host or modified bridge. v1 does not isolate
the bridge under another OS user. Enable and independently verify host disk
encryption such as FileVault. SQLite has no application-level encryption, and
there is no `doctor` command that checks it.

Slack text is labeled and untrusted. Reply refuses until inbox has shown
changed source text. Output is one markdown block, at most 12,000 characters,
with mentions neutralized and unfurls disabled. Known secret shapes and URLs
with credentials are refused at queue and send time without repeating the
secret. Private-network URLs are not separately policed. This is not enterprise
DLP and does not constrain the lead's other shell tools.

## Retention and deletion

Cleanup runs at startup and hourly, so the bridge keeps Slack text for at most
30 days after it last changed. Only a post that may still go out keeps its text
longer. Rows that outlast their text hold identifiers, timestamps, states and
hashes that posting once and numbering need.

- `messages` rows go once their latest posted or edited version is over 30
  days old, including markers and tombstones. A marker or tombstone keeps its
  author's role but not their user ID.
- `changes` keeps only each remaining message's latest change, which holds
  identifiers, a timestamp and a kind.
- A finished request goes, with its `request_messages` and the `outbox` rows
  of its reply and the posts in its thread, once the ledger keeps none of its
  messages. The reason the lead gave for dismissing it goes with it. A request
  whose reply's delivery is unknown never finishes, so it stays, with no text,
  and a finished one stays while a post in its thread may still go out or its
  delivery is unknown.
- An `outbox` row forgets its payload 30 days after it last changed, unless it
  is queued or sending, such as a reply queued while its link is paused. Its
  number, payload hash, state, destination and Slack `ts` remain, so an unknown
  post can still be proven and a publication slot stays reserved.
- `users` and `user_aliases` keep a person's name and other IDs only while a
  link allows them.

There are no downloaded files, coverage records or durable event receipts to
retain.

Unlink removes a link's owned bridge data. Observed app uninstall, or token
revocation naming our bot, empties all other tables and leaves the installation
marked uninstalled. Other credential errors stop work but retain data for
repair. The credential file and the login job's log remain and need separate
offboarding cleanup. An offline bridge cannot detect uninstall immediately.

When observed, Slack deletion, a tombstone or EKM/DLP withdrawal redacts the
ledger's message and can cancel a pending request and its queued answer.
It does not retract an answer already sent or erase model context. Slack's
[EKM](https://slack.com/help/articles/360019110974-Slack-Enterprise-Key-Management)
and [DLP](https://slack.com/help/articles/12914005852819-Slack-data-loss-prevention)
do not revoke copies already exported. Data can reach the model before Slack
later hides it.

**Bridge deletion stops at bridge-managed data.** It does not erase Toy Box
transcripts, model/provider copies, copied workspace files, sent Slack posts,
backups or snapshots. SQLite deletion is logical, not forensic erasure of the
database or WAL. Approve a separate deletion and restore process for those
copies. Slack retention, residency and
[legal hold](https://slack.com/help/articles/4401830811795-Create-and-manage-legal-holds)
do not automatically apply, and the bridge is not a compliance archive.

## Operations and approval gates

The [operations guide](operations.md) covers status and uncertain posts.
The bridge locks its data folder and commits event effects before acking.
Ambiguous posts are checked for matching metadata about one and five minutes
later, then remain unknown and reserved. They are never automatically resent,
and no human-resolution command releases the reservation.

Catch-up rereads up to 30 days of roots and follows threads with recent replies.
It can recover new messages and current edits, but cannot reliably repair
missed deletes. It misses replies on older roots and reply edits in threads
it does not revisit. Unfinished reads are retried and reported in status,
but do not hold posts. Successful API access is not proof of complete history
or approval for AI processing.

v1 refuses Slack Connect, pending external shares, org-wide installs, rotating
credentials and non-Copilot leads. Use exactly one workspace installation.
An internal org-shared channel does not require installing the app in each
workspace. Do not weaken company controls if they require unsupported features.

Besides its README and package.json, the npm package holds only a launcher
script and one compiled Bun binary for Apple silicon Macs. The binary bundles
the dependencies `bun.lock` pins, and installing the package runs no scripts.
The maintainer built and published 0.1.0 from a clean clone of the commit
tagged v0.1.0. Later releases are built, tested and published by the
repository's Publish workflow through npm trusted publishing, which adds
provenance. Each GitHub release attaches the tarball npm serves.

Before rollout, assign app collaborators, operator, maintainer, incident and
support contacts. Approve the host and network controls, credential handling,
dependency updates, backup/restore, offboarding and deletion. On compromise,
stop the bridge and use Slack's approved containment process. Coordinate
evidence preservation and deletion with security. Slack's Developer Policy
requires immediate notice to Slack and affected users for a data breach.

Verify these against landed code, not this document:

- The manifest's eight scopes, startup token/app/workspace/org identity checks,
  Enterprise routing and refusal of unsupported installations.
- Exact-ID request admission, caller refusal, terminal-only widening,
  fresh channel checks, and suspension behavior under races and failed lookups.
- Observation boundaries, stale-question refusal, send-time safety, no
  duplicate send after a crash, and explicit unknown-post status.
- Retention and unlink/uninstall cascades, including outbox text and WAL,
  plus the separately approved external-copy deletion process.
- Permissions, loopback-only configuration, secret-safe diagnostics and the
  actual operator instructions. Record provider contracts separately.
