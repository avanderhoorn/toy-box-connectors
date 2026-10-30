## 📅 v0.3.0 (10/30/26)

- `toy-box-slack post` lets the lead post in the linked Slack channel, or in one of its threads, when you ask in Toy Box or a routine says to. When someone asks it to post from Slack, the lead tells you instead. A post still waiting when the link is paused or suspended never goes out, and resume names it so you can ask the lead again
- `post --mention` notifies people on the allowlist, by the member IDs status shows
- Status lists each allowed person by name and member ID. In `status --json`, allowlist entries are now `{ userId, name }` instead of names
- Resuming or relinking a channel more people can read now drops what the lead wrote for fewer, names it, and gives the lead those requests back to answer again
- The lead can't post a PGP private key block, as with the other secrets the bridge refuses
- Updating and restarting `serve` is all it takes, and leads keep the routines they have. The first start upgrades bridge.db, which 0.2.x can't open afterward. If 0.2.x asks you to remove it, install 0.3.0 again instead, since removing it forgets every link

## 📅 v0.2.1 (10/30/26)

- Whoever asks sees 👀 as soon as the lead is woken, rather than when it reads the request
- A burst of messages settles in 3 seconds before the lead is woken, rather than 10
- `allow` reads naturally for one person, and names the channel as Slack does rather than by its ID
- `status` says whom a link answers as plainly for one person as for several
- `status` names each link's Slack and Toy Box channels, and shows a channel by its ID when Slack or Toy Box can't name it within two seconds. With `--json`, `slackChannel` now holds the name, beside the new `slackChannelId` and `toyBoxChannel`
- Updating and restarting `serve` is all it takes, and leads keep the routines they have

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
