## 📅 v0.2.0 (10/29/26)

- The passphrase is gone. `link`, `allow` and `resume` still run only at your terminal, never in a lead's shell, and now apply at once and say what changed, with names from Slack. `deny`, `pause` and `unlink` undo them
- Before you restart `serve`, delete the `OWNER_PASSPHRASE_HASH` line from `credentials.env` in the bridge's data folder, `~/.toy-box-slack` by default. `serve` refuses the file until you do
- `serve` asks only for the tokens it's missing
- Routine prompts haven't changed, so leads can keep the routines they have

## 📅 v0.1.0 (10/29/26)

- First release. One bridge lets a Toy Box channel's Copilot lead answer allowed people in a linked Slack channel, in the thread they asked in
- Leads can publish release notes and digests to Slack on a schedule, and bring Slack activity back to their Toy Box channel
- Only the owner widens who can make a lead act, with a passphrase the bridge checks, and a channel or policy change suspends the link for review
- One bridge can host several Slack apps, each with its own tokens and data
- Installs from npm as one CLI, and `serve` installs the skill leads learn it from
