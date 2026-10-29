# toy-box-slack

One local bridge lets a [Toy Box](https://github.com/lostintangent/toy-box) channel's Copilot lead answer allowed people in one Slack channel, publish scheduled release notes there, and bring useful activity back to Toy Box.

It guarantees four things: only allowlisted people can open requests, only the owner widens access, a post whose delivery is uncertain is never resent, and every Slack event the bridge acknowledges survives a crash, with anything it missed recovered or reported. Rare channel or policy changes suspend the link for the owner to review. The bridge keeps only what its links need, by default what allowed people say and the threads they ask in, and forgets any Slack text 30 days after it last changed. See [operations](docs/operations.md) for recovery and retention limits.

No DMs, attachments, Slack Connect, org-wide installs, rotating tokens or non-Copilot leads. Slack text the lead reads reaches Copilot and its selected model provider. Obtain company approval first and read the [reviewer guide](docs/security-review.md).

## Before you start

On an Apple silicon Mac, install [Node 24](https://nodejs.org/en/download). With the Mac's default zsh, put `~/.local/bin` on your PATH, then install Copilot, Toy Box and toy-box-slack:

```sh
export PATH="$HOME/.local/bin:$PATH"
printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
npm install --global --prefix "$HOME/.local" @github/copilot @lostintangent/toy-box @avanderhoorn/toy-box-slack
```

Run `copilot`, use `/login` to sign in, then exit. Start Toy Box **from this PATH**, so its leads can find `toy-box-slack`:

```sh
toy-box --host 127.0.0.1
```

Toy Box has no authentication. Never expose it publicly or through a tunnel.

## Set up

Toy Box keeps its terminal, so use another for these three steps.

1. **Create the Slack app.** At <https://api.slack.com/apps>, choose **Create New App > From a manifest**, choose the approved workspace, and paste [docs/manifest.yaml](docs/manifest.yaml). Review the eight bot scopes and create the app. Install it to that workspace from **OAuth & Permissions**, which then shows its **Bot User OAuth Token** (`xoxb-...`). Under **Basic Information > App-Level Tokens**, generate an app-level token (`xapp-...`) with `connections:write`. The manifest already enables Socket Mode, so no public Request URL is needed. Do not enable token rotation.

2. **Start the bridge.** Run `toy-box-slack serve` and keep it running. The first time, it asks for both tokens and for a passphrase you choose, typed twice. Paste the tokens only there, never into Toy Box, Slack or the repository. Nothing you type is shown. `link`, `allow` and `resume` ask for the passphrase before they widen who can make the lead act, so make it strong and unique, and never put it in Toy Box or Slack. Each time it starts, `serve` installs the skill leads learn the CLI from, and names the file.

3. **Link the channels.**
   - In Slack, invite the app into the channel with `/invite` and select **Toy Box**. Copy the channel ID from the bottom of its details, and each allowed person's member ID from their profile.
   - Open <http://127.0.0.1:3000> and create a channel with a Copilot lead (tested with `claude-sonnet-5`). To use a lead that was already running instead, ask it to read the file `serve` named, since Copilot reads skills when a lead's session starts or resumes.
   - Ask the lead to set up Slack for those IDs. It creates its inbox routine and prints the exact `link` and `allow` commands. Run them yourself in another terminal, and review each preview before you enter the passphrase. Their forms are:

     ```sh
     toy-box-slack link --channel TOYBOX_ID --slack-channel SLACK_ID
     toy-box-slack allow --channel TOYBOX_ID USER_ID
     ```

Defaults are `--requests mention --observe requesters`; `--requests all` accepts any allowed person's top-level post, and `--observe channel` lets a digest read other people's text too. Ask the lead for opt-in digest or release-note routines if wanted.

Send a **new** mention by selecting the app in Slack's mention menu. An allowed person's question should get eyes and one threaded answer within minutes. If it does not, check `toy-box-slack status` and the [operations guide](docs/operations.md).

## Several leads in one Slack channel

People tell leads apart by the bot they mention, so leads in the same Slack channel each need a Slack app of their own, while leads in different Slack channels share one. Create another Slack app, add it to the bridge with `toy-box-slack add-app <name>`, and link through it with `--app <name>`, as [operations](docs/operations.md#add-or-remove-an-app) describes. Ask people there to mention the lead they mean, since a reply that mentions no one reaches every lead its author asked in that thread. Two links with `--requests all` both answer each top-level post that mentions no one, from someone they both allow.

## Keep it running

The bridge answers only while `serve` runs. Ctrl-C stops it. When `serve` runs again, it catches up on what it missed, within the [limits](docs/operations.md#deletion-and-limits) of catch-up. To start it at login instead, see [operations](docs/operations.md#start-the-bridge-at-login).

`serve` keeps the tokens and the passphrase's hash in `~/.toy-box-slack/credentials.env`, which only you can read. The bridge reads this file, not a `.env`, and environment variables of the same names override it. `TOY_BOX_SLACK_HOME` selects another data folder, and `TOY_BOX_URL` a Toy Box other than <http://127.0.0.1:3000>. `toy-box-slack passphrase` changes the passphrase, given the old one, without a restart.

To update, run `npm install --global --prefix "$HOME/.local" @avanderhoorn/toy-box-slack` again, then restart `serve`, or the [login job](docs/operations.md#start-the-bridge-at-login) that runs it. `serve` installs the new release's skill, so ask your leads to set their routines again from it, since a routine keeps the prompt it was created with.

To remove it, ask each lead to delete its Slack routines, then stop `serve`, or stop the [login job](docs/operations.md#start-the-bridge-at-login) if you set one up and delete its plist. Run `npm uninstall --global --prefix "$HOME/.local" @avanderhoorn/toy-box-slack`, delete `~/.toy-box-slack` and the skill folder `~/.copilot/skills/toy-box-slack`, and uninstall each Slack app at <https://api.slack.com/apps>. Copies outside the bridge, such as Toy Box transcripts and posts already in Slack, stay, as the [reviewer guide](docs/security-review.md#retention-and-deletion) explains.

## Commands

**Lead:** `inbox`, `reply`, `dismiss`, `activity`, `mark-read`, `publish`, `retract`. **Owner:** `passphrase`, `add-app`, `link`, `allow`, `resume`. **Lead or terminal:** `status`, `deny`, `pause`, `unlink`. **Operator:** `serve`.

`toy-box-slack <command> --help` gives flags. See [operations](docs/operations.md) for status, pauses, uncertain posts, deletion and starting at login, [AGENTS.md](AGENTS.md) for architecture, and [research](docs/research) for evidence.

## Developing

1. Install [Bun](https://bun.com/docs/installation) 1.4.4, which CI builds with, and clone this repo
1. Run `bun install`, which also points Git at the pre-commit hook
1. Run `bun run check` and `bun test`, which CI runs on every push and pull request

`./cli/index.ts` runs the CLI from source. `bun run build` compiles the binary the npm package ships, and `./toy-box-slack` runs it as npm installs it.

## Publishing

Update `package.json` to the next stable version and keep its release notes under a matching `## 📅 vX.Y.Z (date)` heading in `CHANGELOG.md`, saying what changed for owners and anything they must do besides updating. Commit and push those changes. CI runs neither the end-to-end suite nor the live check, so run both on that commit as [tests/AGENTS.md](tests/AGENTS.md) describes. Then select **Actions → Publish → Run workflow** on the branch to release.

The workflow reads the version and notes from that exact commit, rejects an already published npm version, runs checks and tests, and builds the Apple silicon macOS CLI. It publishes the tested package through npm trusted publishing, then creates the matching GitHub tag and release with the changelog notes and npm tarball attached. No npm token or separately entered release version is needed.

npm accepts that publish only from the package's trusted publisher, and the package has none yet because 0.1.0 was published by hand. Before the first release from the workflow, a maintainer with 2FA adds it from a terminal signed in to npm, with `--allow-publish` since a new trusted publisher can only stage a publish by default. Then run the workflow within 2 days, since npm expires a trusted publisher that hasn't published by then.

```sh
npm trust github @avanderhoorn/toy-box-slack --repo avanderhoorn/toy-box-connectors --file publish.yml --allow-publish
```

If a run fails before npm publication, fix the failure and rerun. If npm succeeds but GitHub release creation fails, recover the tarball from npm with `npm pack @avanderhoorn/toy-box-slack@X.Y.Z --ignore-scripts`, verify its registry integrity, and use that tarball and the original commit's changelog notes to finish the GitHub release manually. Do not rebuild or republish the same npm version.
