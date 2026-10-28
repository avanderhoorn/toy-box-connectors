# Slack app review

toy-box-slack lets a Toy Box channel's lead read a selected Slack channel,
answer allowed people in threads, and publish scheduled updates. A local Bun
process holds the Slack tokens and a SQLite ledger. The lead runs on Copilot
and uses a CLI to read that ledger and queue Slack posts.

**Review status:** this describes the v1 design, not an attestation that every
control has shipped. Implementation and security review are still in progress.
The checks at the end must pass before deployment. No real Enterprise
workspace has yet verified the Enterprise payload assumptions. GitHub's private
Slack policies and approval process have not been verified.
Platform evidence is in the [Slack research](research/slack.md#enterprise-deployment-verified-2026-10-28).

## What Slack access permits

Use a company-owned internal app installed in exactly one workspace, with the
bot invited only to approved channels. Each link binds one Toy Box channel to
one monitored Slack channel. Publications may have a separate approved
destination. There is no autojoin, DM access, user token or impersonation.

[The manifest](manifest.yaml) requests these nine bot scopes:

| Scope                                                                                     | Why it is needed                                                                                                                   |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`channels:history`](https://docs.slack.dev/reference/scopes/channels.history/)           | Receive public-channel messages and recover history and tracked threads after a gap.                                               |
| [`channels:read`](https://docs.slack.dev/reference/scopes/channels.read/)                 | List public channels and check their membership, archive state and audience before linking or sending.                             |
| [`groups:history`](https://docs.slack.dev/reference/scopes/groups.history/)               | The same message and recovery access for private channels the bot has joined.                                                      |
| [`groups:read`](https://docs.slack.dev/reference/scopes/groups.read/)                     | Identify those private channels and check their membership and audience.                                                           |
| [`users:read`](https://docs.slack.dev/reference/scopes/users.read/)                       | Resolve names, verify accounts before admission, refresh membership and identify the installed bot. Email access is not requested. |
| [`chat:write`](https://docs.slack.dev/reference/scopes/chat.write/)                       | Post replies, progress notes and publications, update the bot's own progress notes, and retract its posts.                         |
| [`metadata.message:read`](https://docs.slack.dev/reference/scopes/metadata.message.read/) | Find the bridge's outbox metadata when a post may have succeeded but its response was lost.                                        |
| [`files:read`](https://docs.slack.dev/reference/scopes/files.read/)                       | Read attachment metadata and download a linked message's file when requested. No file upload scope is requested.                   |
| [`reactions:write`](https://docs.slack.dev/reference/scopes/reactions.write/)             | Add or remove the bot's status reactions.                                                                                          |

Socket Mode also needs an **app-level** token with `connections:write`.
Socket Mode is enabled, and interactivity is not. Slack connections are
outbound HTTPS and secure WebSockets, so no public request endpoint or inbound
firewall opening is needed.
There are no admin, SCIM, Discovery, search or `chat:write.public` scopes.

**Slack permissions are broader than our filter.** A bot token can access the
conversations Slack makes available to it, not just linked channels or
allowlisted authors. The app can receive subscribed events from other channels
it has joined. The bridge discards unlinked message content before storing it,
but local filtering does not narrow the credential's capability.

By default, `requesters` observation keeps text from allowed people, the bot,
and **anyone posting in a request thread**. Other messages become content-free
markers. Opt-in `channel` observation keeps other people's text throughout the
channel too. Other bots' text is never kept. The allowlist limits who opens
requests, not whose words can become model context. It is not a reader access
list for Toy Box.

## Where copies go

| Destination                                     | Data and purpose                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge data folder, normally `~/.toy-box-slack` | `bridge.db` and its SQLite write-ahead log (WAL) hold retained message text, request context, profiles and account IDs, settings, coverage records, and queued output. Requested attachments are saved in the files folder. Credentials are separate from the ledger. |
| Local Toy Box                                   | CLI output and other tool results enter the lead's session transcript and conversation context. The lead may post digests into the Toy Box channel and create reports or other workspace files. The bridge does not mirror a Toy Box transcript into Slack.           |
| Copilot and the selected model provider         | Slack text the lead reads, tool results and file content it opens can enter model requests. A Copilot-only lead does not establish a provider, processing region, retention period or no-training contract.                                                           |
| Slack                                           | Thread replies, progress, reactions and approved publications are written back.                                                                                                                                                                                       |
| Host backups and diagnostics                    | Backups, snapshots, copied reports and support bundles can become additional copies. Approve their contents, access and retention before enabling them.                                                                                                               |

Before approval, name the actual Copilot account and plan, permitted models and
providers and their subprocessors, processing regions, retention, support access
and contractual training restrictions. Tell affected users what will leave Slack,
including unallowlisted thread context. Do not copy production data into tests
or incident reports without approval.

File downloads must be HTTPS from exactly `files.slack.com`, without redirects,
at most 20 MB and of an allowed type. These checks do not establish that an
attachment is safe or sandbox the lead's tools.

Slack's [Developer Policy](https://docs.slack.dev/developer-policy/), effective
December 10, 2024, prohibits training an LLM on Slack data and requires consent,
necessary scopes, strong encryption, an accessible privacy policy and deletion
within 14 business days of app deletion or discontinuation. **This guide is not
that privacy policy or a legal determination that a provider arrangement
complies.** The company must approve the actual data-processing terms.

## Who can act or widen access

One person owns the installation: whoever holds the passphrase set when the
bridge was installed. The bridge keeps only an argon2id hash of it, and a
forgotten passphrase, or a handover, means removing its line from the config
file and setting a new one.

Each link's allowlist is matched by exact Slack IDs and Slack-established
aliases, never names, email or the workspace named on a message. Admission
uses `users.info` and accepts only active full members of the installation's
workspace, or its Enterprise org. Guests, foreign-org accounts, bots, workflow
bots and Slackbot are refused. Checks repeat at startup and hourly. A failed
lookup retains the previous decision, so an outage can prolong stale
membership evidence.

An allowed person whose account is deactivated or who leaves the org is removed
at the next successful hourly check, as if denied.

By default, an allowed person mentions the bot to open a request and can
follow up in its thread. The owner can choose `all` request mode instead.
Other people cannot open requests, but their retained text can influence the
lead. Scheduled digests and publications are opt-in routines, not requests
from arbitrary Slack authors.

Widening changes require the **owner's passphrase at a terminal**: linking a
channel, allowing someone and resuming a link. Each shows what it widens, with
names from Slack, before it asks, and the bridge checks the passphrase itself,
so neither a Slack message nor the lead can widen access. There is no way to
approve a change from Slack. Narrowing, including pause, deny and unlink,
applies immediately.

An internally shared channel is allowed only within the pinned Enterprise org
with a known workspace audience. Adding a workspace or changing private to
public widens the audience and suspends the link until the owner resumes it.
Send-time checks compare fresh channel facts with **what the owner approved**,
not the previous refresh. They bound staleness but cannot make a send atomic
with Slack's next change. Company admins still control app access and channel
placement.

Only the channel's lead can reply or publish through the CLI. Members can
read, and the operator can read and change setup but cannot reply or publish.
These caller roles prevent mistakes, not hostile local processes. The rule
that consequential work asked for in Slack waits for the owner's go-ahead in
Toy Box lives in the skill and routine prompt. It is not an execution sandbox.

## Host and secret boundary

The design is one owner on one Mac. The bridge folder is 0700,
`credentials.env` and the Unix socket are 0600, and tokens are used only by
the bridge, not included in CLI output or prompts. Environment variables can
supply credentials instead. `doctor` checks FileVault; the SQLite database and
downloaded files have no separate application-level encryption.

The bridge opens no TCP listener. It contacts Toy Box over loopback HTTP.
**Toy Box has no authentication and must never be exposed publicly.** Run it
with `--host 127.0.0.1`. Loopback and Unix permissions are not protection
against another process running as the same OS user.

A shell-capable lead with that UID can read credentials, edit the database,
forge caller identity, stop the bridge or replace its code. FileVault protects
a locked disk, not a running same-UID attacker. The passphrase is an
authorization boundary only while the bridge and host remain intact. v1 does
not isolate the bridge under a separate OS user.

Slack text is labeled and treated as untrusted input. Send-time checks enforce
the destination and request revision, neutralize mentions, disable unfurls and
refuse known secret shapes and private-network links without echoing them.
These checks are not enterprise DLP and do not constrain every tool the lead
can run. The reviewer must accept that trust boundary or reject this deployment.

## Retention and deletion

The design keeps message text for 30 days, except the source of an unfinished
request. Files expire after 7 days and are removed sooner when Slack deletes
the file or its message, or when the link is removed. Content-free event receipts
expire after 7 days. Log entries carry identifiers, not message text;
identifiers still require an access and retention policy.

Unlinking deletes that link's bridge data. Once observed, app uninstall or
revocation naming the pinned bot user deletes all Slack data and settings,
keeping only the installation, marked uninstalled. Other credential errors
suspend work without deleting it. An offline bridge cannot promise immediate
detection.

When Slack withdraws access through EKM redaction or a hidden or tombstoned
snapshot, the design removes cached text and files even without a newer edit,
marks the source unverified and holds affected replies. It must not restore
that text from an older snapshot. Slack EKM does not by itself revoke our
local or model copies, and Slack DLP is not a guaranteed pre-export gate.
Data can reach the model before an administrator later hides or deletes it.

**Bridge deletion stops at bridge-managed data.** It does not erase Toy Box
transcripts, already-consumed model context, provider copies, reports or files
the lead copied elsewhere, Slack posts already sent, backups or snapshots.
Logical SQLite deletion is not a forensic-erasure guarantee for the database
or WAL. The operator needs a separately approved deletion process for all
those copies, including restored backups.

Slack retention, data residency and legal hold do not automatically apply to
these external copies. The bridge is not a compliance archive and has no
legal hold or export integration. Do not silently disable deletion to approximate
a hold. The compliance owner must decide whether these operational copies
are permitted and how preservation and erasure requests reach their operator.

See Slack's [EKM coverage](https://slack.com/help/articles/360019110974-Slack-Enterprise-Key-Management),
[DLP behavior](https://slack.com/help/articles/12914005852819-Slack-data-loss-prevention)
and [legal holds](https://slack.com/help/articles/4401830811795-Create-and-manage-legal-holds).

## Operation and company decisions

App approval is not Marketplace certification. Slack's
[Marketplace-only setting does not prevent internal apps](https://slack.com/help/articles/1500009181142-Manage-app-settings-and-permissions),
but ordinary app approval and company policy still apply. Use a company-owned
app and name its collaborators, operator, maintainer, support and incident
contacts before rollout.

The bridge uses an exclusive process lock and commits receipts before
acknowledging events. It reports recovery gaps rather than promising complete
Slack history. A possibly delivered post is held for reconciliation or human
resolution, never blindly retried. Channel access failures and admin policy
refusals are not worked around. A storage error stops the bridge for supervisor
recovery.

The company must approve the host, device management and network controls,
credential storage and rotation policy, dependency and security update ownership, monitoring,
backup and restore testing, incident response and offboarding. On suspected
compromise, stop the bridge and contain access through Slack's approved admin
process. Coordinate evidence preservation and copy deletion with security,
not an ad hoc database reset. Slack's Developer Policy requires immediate
notice to Slack and affected users when data is compromised.

**v1 refuses** Slack Connect and pending external shares, org-wide installs
and rotating bot or app credentials. A dedicated app with exactly one workspace
installation is a deployment prerequisite, not something a truncated event
authorization can prove. A second installation is unsupported and can cause
events to be discarded with a diagnostic. Internal org-shared channels do not
require a second installation. DMs, guests as the owner or requesters, non-Copilot
leads and separate-OS-user isolation are also outside v1.

If the company mandates token rotation, org-wide deployment, stronger host
isolation, guaranteed pre-export DLP, end-to-end erasure or compliance hold
integration, those are feature or design blockers. Do not disable required
company controls to install the app. Approve exact monitored and publication
channels and the audience of the linked Toy Box channel as well as model terms and
copy policies. Successful Slack API access is not approval for AI processing.
Do not assume Slack's
[native AI-use restrictions](https://slack.com/help/articles/47421816860947-Restrict-AI-access-to-certain-channels-canvases-and-lists)
also enforce a custom Events API bot's processing policy.

## Claims to verify against the implementation

- The manifest and runtime request only the listed access; identity checks
  refuse rotating credentials and org-wide installs, pin the workspace, org,
  app and bot, route Enterprise events correctly and never retain raw credentials
  in logs.
- Exact-ID and alias admission, hourly rechecks and the passphrase check on
  every widening command enforce the stated rules, including failed lookups,
  races, prompt-injection attempts and account departures. No command the
  bridge serves can set or clear the passphrase.
- Observation and file reads enforce linked-channel filtering, and sends recheck
  requester, revision and the approved audience without an admin-policy bypass.
- Retention and deletion cover message text, request context, outbox text, files
  and all owned rows, with the stated exceptions and triggers. Verify database,
  WAL, backup and restore behavior rather than infer secure erasure.
- Access withdrawal removes old content, prevents stale replay and holds
  affected output. Crash recovery and ambiguous sends never silently replay
  a possibly delivered post.
- Data folder, socket and credential permissions, loopback-only configuration,
  secret-safe diagnostics and shipped operator instructions match this guide.
  Record the actual provider terms and approved external-copy deletion process
  separately.
