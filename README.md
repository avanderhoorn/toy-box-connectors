# 💬 Toy Box Slack

Toy Box Slack lets a [Toy Box](https://github.com/lostintangent/toy-box) channel's Copilot lead work in one Slack channel. People you allow ask the lead questions there and get answers in their threads, the lead can publish release notes on a schedule, and useful Slack activity comes back to the Toy Box channel for discussion.

It runs as one local bridge beside Toy Box on your Mac. Only the bridge holds the Slack tokens, and it connects through Socket Mode, so it needs no public URL. The lead reaches Slack only through the `toy-box-slack` CLI.

## Features

- **Answers in threads:** When someone you allow mentions the app, the bridge wakes the channel's lead, which reacts with 👀 as it reads the request and answers once in its thread.
- **Only the people you allow:** Only people on the link's allowlist, by exact Slack member ID, can make the lead act, and the bridge checks that before the lead sees anything. Only you widen access, at your terminal, while the lead can only narrow it.
- **Nothing lost or sent twice:** Every Slack event the bridge acknowledges survives a crash, and anything it missed while stopped is recovered or reported. A post whose delivery is uncertain is looked up in Slack, never sent again.
- **Release notes and digests:** Optional routines publish release notes in the Slack channel, and bring a digest of what people said there back to the Toy Box channel.
- **Several leads:** One bridge hosts several Slack apps, so leads that share a Slack channel each answer as their own bot.
- **Keeps little:** By default the bridge keeps only what allowed people say and the threads they ask in, and it forgets any Slack text 30 days after it last changed.
- **Stops when the channel changes:** If the channel is shared outside your organization, made public or archived, or the app is removed from it, the bridge suspends the link for you to review.

It doesn't support DMs, attachments, Slack Connect, org-wide installs, rotating tokens, or Codex and Claude Code leads.

> ⚠️ Slack text the lead reads reaches Copilot and its selected model provider. Get your company's approval before you link a workspace, and read the [reviewer guide](docs/security-review.md).

## Getting Started

You need an Apple silicon Mac with [Node 24](https://nodejs.org/en/download), and a Slack workspace you're approved to add an app to.

1. Put `~/.local/bin` on your PATH, and install Copilot, Toy Box and Toy Box Slack there:

   ```sh
   export PATH="$HOME/.local/bin:$PATH"
   echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
   npm install --global --prefix "$HOME/.local" \
     @github/copilot @lostintangent/toy-box @avanderhoorn/toy-box-slack
   ```

1. Run `copilot`, sign in with `/login`, then exit.

1. Start Toy Box from that PATH, so its leads can find `toy-box-slack`, and keep it running:

   ```sh
   toy-box --host 127.0.0.1
   ```

   > ⚠️ Toy Box has no authentication. Never expose it publicly or through a tunnel.

1. Create the Slack app:
   - At <https://api.slack.com/apps>, choose **Create New App → From a manifest**, pick the approved workspace, and paste [docs/manifest.yaml](docs/manifest.yaml).
   - Review its eight bot scopes, create the app, and install it from **OAuth & Permissions**, which then shows its **Bot User OAuth Token** (`xoxb-...`).
   - Under **Basic Information → App-Level Tokens**, generate a token (`xapp-...`) with the `connections:write` scope.
   - Leave token rotation off. The manifest already turns on Socket Mode, so the app needs no Request URL.

1. In another terminal, run `toy-box-slack serve` and keep it running. The first time, it asks for both tokens, without showing what you type.
   - Paste the tokens only there, never into Toy Box, Slack or the repository.
   - Each time it starts, `serve` installs the skill leads learn the CLI from, and names its file.

1. In Slack, invite the app to the channel with `/invite` and select **Toy Box**. Copy the channel's ID from the bottom of its details, and each allowed person's member ID from their profile.

1. Open <http://127.0.0.1:3000>, create a channel with a Copilot lead (tested with `claude-sonnet-5`), and ask it to set up Slack for those IDs. To use a lead that was already running, first ask it to read the skill file `serve` named, since Copilot reads skills when a session starts or resumes.

1. The lead creates its requests routine and gives you a `link` and an `allow` command. Run them in another terminal. Each says what it changed, with names from Slack, and `deny` or `unlink` undoes it:

   ```sh
   toy-box-slack link --channel TOYBOX_ID --slack-channel SLACK_ID
   toy-box-slack allow --channel TOYBOX_ID USER_ID
   ```

1. Send a **new** mention, picking the app from Slack's mention menu. Within minutes, you should see 👀 on it and one answer in its thread. If not, run `toy-box-slack status` and see the [operations guide](docs/operations.md).

## Link Options

By default, an allowed person asks the lead by mentioning the app, and the lead reads only what allowed people say and the threads they ask in. To widen that, add either option to `link`, or run `link` again with it later:

- `--requests all` makes any top-level post from an allowed person a request too.
- `--observe channel` lets the lead read the whole channel, so digests cover everyone.

`--requests mention` and `--observe requesters` set them back.

## Routines

The lead does its Slack work in Toy Box routines it creates from the skill. Ask it for a different schedule if these don't suit you.

- **Slack requests:** The lead answers each waiting request in its Slack thread, whenever the bridge wakes it and on weekdays at 9:00. It creates this routine as it sets up Slack.
- **Slack digest:** If you ask for it, the lead posts what's worth the team's attention in the Toy Box channel on weekdays at 17:00.
- **Release notes:** If you ask for it, the lead publishes notes in the Slack channel on what the git log and completed tasks say shipped, on Fridays at 16:00 or every weekday.

## Several Leads in One Slack Channel

People tell leads apart by the app they mention, so leads that share a Slack channel each need their own Slack app, while leads in different Slack channels can share one. To add an app for another lead:

1. Create another Slack app from the manifest, changing only its `name` and `display_name`. Install it, generate its app-level token, and invite it to the channel.
1. In a terminal, run `toy-box-slack add-app <name>`, which asks for the app's two tokens.
1. Restart `serve`, which starts every app it hosts.
1. Ask the new lead to set up Slack. Its `link` command names the app with `--app <name>`.

Ask people there to mention the lead they mean, since a reply that mentions no one reaches every lead its author asked in that thread. Two links with `--requests all` both answer a top-level post that mentions no one, from someone they both allow. The [operations guide](docs/operations.md#add-or-remove-an-app) covers app names, Slack's limits and removing an app.

## Keeping It Running

The bridge answers only while `serve` runs, and Ctrl-C stops it. When `serve` runs again, it catches up on what it missed, within [limits](docs/operations.md#deletion-and-limits). To start it at login instead, see the [operations guide](docs/operations.md#start-the-bridge-at-login).

`serve` keeps the tokens in `~/.toy-box-slack/credentials.env`, which only you can read. The bridge reads this file, not a `.env`, and environment variables of the same names override it.

| Variable             | Default                 | What it sets                             |
| -------------------- | ----------------------- | ---------------------------------------- |
| `TOY_BOX_SLACK_HOME` | `~/.toy-box-slack`      | The bridge's data folder                 |
| `TOY_BOX_URL`        | `http://127.0.0.1:3000` | The Toy Box whose leads the bridge wakes |

## Updating

Install the new release, then restart `serve`, or the [login job](docs/operations.md#start-the-bridge-at-login) that runs it:

```sh
npm install --global --prefix "$HOME/.local" @avanderhoorn/toy-box-slack
```

`serve` installs the new release's skill. A routine keeps the prompt it was created with, so ask each lead to set its routines again from the new skill.

## Uninstalling

1. Ask each lead to delete its Slack routines.
1. Stop `serve`, or stop the [login job](docs/operations.md#start-the-bridge-at-login) and delete its plist.
1. Uninstall the CLI, and delete its data folder and skill:

   ```sh
   npm uninstall --global --prefix "$HOME/.local" @avanderhoorn/toy-box-slack
   rm -rf ~/.toy-box-slack ~/.copilot/skills/toy-box-slack
   ```

1. Uninstall each Slack app at <https://api.slack.com/apps>.

Copies outside the bridge stay, such as Toy Box transcripts and posts already in Slack, as the [reviewer guide](docs/security-review.md#retention-and-deletion) explains.

## Commands

| Command     | Who runs it     | What it does                                                  |
| ----------- | --------------- | ------------------------------------------------------------- |
| `serve`     | You             | Run the bridge and install its skill                          |
| `add-app`   | You             | Add another Slack app for the bridge to host                  |
| `link`      | You             | Link a Toy Box channel to a Slack channel, or change the link |
| `allow`     | You             | Let people make the lead act, by Slack member ID              |
| `resume`    | You             | Answer and post again after a pause or suspension             |
| `status`    | You or the lead | Show the link, Slack's connection, requests and wakes         |
| `deny`      | You or the lead | Disallow people, and cancel their requests                    |
| `pause`     | You or the lead | Stop answering and posting in Slack until you resume          |
| `unlink`    | You or the lead | Remove the link and delete what the bridge kept for it        |
| `inbox`     | The lead        | Read waiting requests, with their threads so far              |
| `reply`     | The lead        | Answer a request in its Slack thread, once                    |
| `dismiss`   | The lead        | End a request that needs no answer                            |
| `activity`  | The lead        | Read what's new in the Slack channel                          |
| `mark-read` | The lead        | Mark activity read, so the next read starts after it          |
| `publish`   | The lead        | Post once in Slack for a routine's latest scheduled run       |
| `retract`   | The lead        | Delete one of its confirmed posts from Slack                  |

Run `toy-box-slack <command> --help` for its options. The [operations guide](docs/operations.md) covers status, pauses, uncertain posts, deletion and starting at login, and [research](docs/research) holds the evidence behind the design.

## Developing

1. Install [Bun](https://bun.com/docs/installation) 1.4.4, which CI uses, and clone this repo
1. Run `bun install`, which also points Git at the pre-commit hook
1. Run `bun run check` and `bun test`

`./cli/index.ts` runs the CLI from source. `bun run build` compiles the binary the npm package ships, and `./toy-box-slack` runs it as npm installs it. [AGENTS.md](AGENTS.md) covers the architecture, testing and releasing.
