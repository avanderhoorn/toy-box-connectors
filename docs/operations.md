# Operating the bridge

Run one bridge per data folder. The [README](../README.md) covers starting it
at a terminal, and the [last section](#start-the-bridge-at-login) covers
starting it at login. Toy Box must run separately on loopback.
Default state lives in `~/.toy-box-slack`; keep its mode 0700 and
`credentials.env` mode 0600.

Replace `TOYBOX_ID` and `USER_ID` below with the IDs from setup.

## Check status

The lead runs `toy-box-slack status`. At a terminal, add
`--channel <toybox-channel-id>` to inspect one link, or omit it to list links.
Status shows the allowlist, pending requests, wake failures and unconfirmed
posts. Use `--json` for structured output.

After reconnecting, a minute of throttled events or an unreadable delivery,
the bridge catches up from channel history and recently active threads.
It waits out API rate limits and retries unfinished reads. A connected
bridge can still report `Can't catch up on messages the bridge may have
missed` in status and logs. Successful recovery clears that problem.
Catch-up trouble does not hold queued posts. Pause the link if output must
wait while you investigate.

For digests, the lead runs `activity`, then the exact `mark-read --through N`
it prints after handling the page. Only the lead can do this. The cursor
cannot go backward or skip beyond what activity served, and a crash before
mark-read leaves the page unread. Thread headings include age and a permalink,
but an old root's text is not repeated just because a new reply arrived.

If Slack requests wait, inspect the wake result and make sure Toy Box is up.
The channel needs an inbox routine whose prompt runs `toy-box-slack inbox`.
The lead creates it using the installed skill. A routine keeps the prompt it
was created with, so after a newer release's `serve` updates the skill, ask
the lead to set its routines again from it. Missing routines are retried;
repeated unserved wakes eventually show stalled. Reading inbox serves work,
so do not run it as the lead merely to inspect status.

## Pause, suspension and repair

A paused link holds queued posts and opens no new requests. Existing requests
still receive edits and deletes. Questions first asked while paused do not
return automatically after resume.
Pause, deny and unlink cannot recall a post already on its way to Slack,
and unlink deletes its local post record.

```sh
toy-box-slack pause --channel TOYBOX_ID
toy-box-slack deny --channel TOYBOX_ID USER_ID
toy-box-slack resume --channel TOYBOX_ID
```

Pause and deny apply immediately without a passphrase. Resume shows its
preview and asks for the passphrase.

The bridge suspends a link itself when Slack reports a change the owner must
review, such as an archive, a widened audience, bot removal or a new channel
ID. Like a paused link, it holds posts and opens no new requests, and status
says why and what ends it. The owner must fix the cause before resuming with
the passphrase. A new Slack channel ID instead requires unlinking the old link
and linking the new ID. Do not edit the database to bypass an audience or
policy refusal.

Channel audience is checked at link, at resume and before every post, not
at startup or before catch-up. If a share or privacy-change event was missed
offline, the audience comparison waits until a later fresh check.

For a bad token, stop the bridge with Ctrl-C, delete the token's line from
`credentials.env`, and run `serve` at a terminal, which asks for it again.
If the bridge starts at login, correct the line instead and restart the job
as the last section describes. Environment variables override that file, so
a stale exported token can hide a correction. Ordinary credential failures
retain the ledger; they are not uninstall events.

Editing `docs/manifest.yaml` does not update Slack. Apply changes in the app's
**App Manifest** settings, follow Slack's reinstall prompt for permission
changes, and update credentials if Slack issues new tokens.

## Unknown posts are not a retry queue

An ambiguous send or a send interrupted by a crash becomes unknown. The
bridge checks its metadata about one and five minutes later. If confirmed,
it records the Slack post. Otherwise status keeps it unconfirmed and lists
the request's permalink when available.

Inspect Slack before drawing conclusions. A missing match does not prove the
post was absent. There is no resend or resolve command, and retraction keeps
the request or scheduled slot reserved. An allowed person's next follow-up
can open a new request.

## Deletion and limits

Unlink deletes that link's owned database rows. Observed app uninstall or
bot-token revocation clears the bridge's other tables, leaving an uninstalled
installation marker. The credential file and the login job's log are not
removed; include them in the approved offboarding process.
Run `toy-box-slack unlink --channel TOYBOX_ID` to remove one link, then have
the lead delete its Slack routines.
Before reinstalling after uninstall, stop the bridge and follow its startup
refusal to remove `bridge.db` and its WAL/SHM companions. Do not reset the
database to recover an unknown post.
Deleting or restoring an older database can also lose post reservations.
Check Slack before resuming publications after any state reset.

Ledger cleanup runs at startup and hourly. It removes messages
whose latest posted or edited version is over 30 days old, including markers
and tombstones. Content-free change records remain. **Outbox payloads do not
expire after 30 days:** queued and sent replies and publications keep their
text until unlink or uninstall.

Catch-up scans roots at most 30 days old and follows threads with replies
since the gap. It takes new or edited versions from five minutes before the
gap, never before the link or the retention horizon. Current snapshots are
not an event log: do not rely on catch-up to repair missed deletes. Replies
on older roots are missed, and reply edits alone do not make a thread get reread.

Bridge deletion does not erase Toy Box transcripts, provider copies, sent
Slack messages, exported files or backups. See the [reviewer guide](security-review.md)
for the separate consent, encryption and deletion approvals.

## Start the bridge at login

The bridge answers only while it runs, and catch-up recovers what it missed
while stopped, within the limits above, so starting it at login is optional.
A login job has no terminal and never asks for anything, so set up with
`serve` at a terminal first, as the README describes, then stop it with
Ctrl-C. From the checkout, generate a per-user
[launchd](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
job:

```sh
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$HOME/Library/LaunchAgents/local.toy-box-slack.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>local.toy-box-slack</string>
  <key>ProgramArguments</key><array>
    <string>$(command -v bun)</string><string>--no-env-file</string>
    <string>$PWD/cli/index.ts</string><string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>$PWD</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.toy-box-slack/bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/.toy-box-slack/bridge.log</string>
</dict></plist>
EOF
plutil -lint "$HOME/Library/LaunchAgents/local.toy-box-slack.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.toy-box-slack.plist"
```

This expands absolute paths now because launchd does not expand `~` or shell
variables. Keep the checkout in place. The job starts at login, not before
login, and does not start Toy Box. Keep Toy Box running separately. The job
starts the bridge again whenever it stops, including after a storage error.
It logs to `~/.toy-box-slack/bridge.log`, which grows until you rotate it.

Stop the job with `launchctl bootout "gui/$(id -u)/local.toy-box-slack"`.
After changing credentials, restart it with
`launchctl kickstart -k "gui/$(id -u)/local.toy-box-slack"`. Do not also run
`serve` at a terminal, since only one bridge can run for a data folder.
