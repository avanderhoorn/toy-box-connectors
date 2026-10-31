## 📅 v0.5.0 (10/31/26)

- The lead can show up to three PNG images below a reply, release note or post, such as a chart it made, each with alt text that says what it shows. The bridge uploads only each image's pixels, keeps no copy, and deletes an image from Slack when its post doesn't go out
- `retract` deletes a post's images along with it
- Inbox and the lead's other commands name the linked Slack channel as #name rather than by its ID. A link from before the update gets its name the first time the lead posts there
- For the lead to show images, add the `files:write` bot scope to each app in its **App Manifest** settings, with `files:read` if it doesn't have it yet, and reinstall it as Slack prompts. Until an app has both, a post with an image is refused with a reason that says which to add, and posts without images work as before
- Restarting `serve` after updating is all the bridge needs, and leads keep the routines they have. Until you restart, the 0.4.0 bridge still runs the lead's commands, except those that show images. The first start upgrades bridge.db, which 0.4.0 can't open afterward

## 📅 v0.4.0 (10/30/26)

- `toy-box-slack file` lets the lead read the text files and PNG or JPEG screenshots that people on the allowlist share, when an answer depends on them. Inbox and activity list each message's files, and say why the lead can't read one, such as a PDF
- The bridge asks Slack about a file and downloads it only when the lead reads it, and only while whoever shared it and whoever uploaded it are on the allowlist. It keeps none of a file's text, and deletes a screenshot about ten minutes after the lead views it
- For the lead to read files, add the `files:read` bot scope to each app in its **App Manifest** settings and reinstall it as Slack prompts. Until an app has it, `file` says how to add it, and everything else works as before
- A message stored before the update lists its files once someone edits it
- Restarting `serve` after updating is all the bridge needs, and leads keep the routines they have. The first start upgrades bridge.db, which 0.3.0 can't open afterward

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
