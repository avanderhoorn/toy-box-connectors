# Links

Links hold the owner's settings for each Toy Box channel's Slack connection: which Slack channel it watches, where publications go, who may make requests, and which routines the lead registered.

## Domain model

A link binds one Toy Box channel to one Slack channel. Its allowlist names Slack people by exact user ID, and only they can make the lead act. Request mode is `mention` by default or `all`, and observe mode is `requesters` by default or `channel`. A link waits for its requests routine before it becomes active. It keeps its channels' audiences as the owner approved them, and the bridge suspends it when Slack or Toy Box makes continuing unsafe.

## Boundaries and invariants

- Only the owner widens access. Linking a channel, allowing a person and resuming a link ask for the passphrase the owner set at install, and the bridge checks it, so neither a Slack message nor the lead can widen access. Narrowing never needs it.
- `model/admission.ts` admits only a full member of the installation's workspace or Enterprise org, never a guest, a deactivated account, a bot or Slackbot, and refuses when users.info leaves out what it needs.
- `model/audience.ts` judges every read of a linked channel against the audience the owner approved, never against the read before it, so a widening suspends the link until the owner resumes it.
- `model/status.ts` names each suspension and what ends it. A link whose Toy Box channel was deleted ends only with unlink, and one whose Slack channel has a new ID only with linking that ID again.
- Every table a link owns cascades from it. Uninstalling the app or revoking its token deletes every row but the installation, which stays marked uninstalled so the bridge won't start again on tokens Slack revoked. No delete touches SQLite's own tables, so outbox items and gaps go on numbering after every one there has been.
