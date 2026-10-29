# toy-box-slack

One local bridge lets a [Toy Box](https://github.com/lostintangent/toy-box) channel's Copilot lead answer allowed people in one Slack channel, publish scheduled release notes there, and bring useful activity back to Toy Box.

The four v1 guarantees are: only allowlisted people can open requests, only the owner widens access, uncertain posts are never resent, and events survive acknowledgement with gaps recovered or reported. Rare channel or policy changes suspend the link for owner review. See [operations](docs/operations.md) for recovery and retention limits.

No DMs, attachments, Slack Connect, org-wide installs, rotating tokens or non-Copilot leads. Slack text the lead reads reaches Copilot and its selected model provider. Obtain company approval first and read the [reviewer guide](docs/security-review.md).

## Before you start

On a Mac, install [Git](https://git-scm.com/download/mac), [Node 24](https://nodejs.org/en/download) and [Bun](https://bun.com/docs/installation) (tested with 1.4.4). With the Mac's default zsh, put `~/.local/bin` and `~/.bun/bin` on your PATH, then install Copilot and Toy Box:

```sh
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
printf '%s\n' 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"' >> "$HOME/.zshrc"
npm install --global --prefix "$HOME/.local" @github/copilot @lostintangent/toy-box
```

Run `copilot`, use `/login` to sign in, then exit. Start Toy Box **from this PATH**, so its leads can find `toy-box-slack`:

```sh
toy-box --host 127.0.0.1
```

Toy Box has no authentication. Never expose it publicly or through a tunnel.

## Set up

Toy Box keeps its terminal, so use another for these four steps.

1. **Create the Slack app.** At <https://api.slack.com/apps>, choose **Create New App > From a manifest**, choose the approved workspace, and paste [docs/manifest.yaml](docs/manifest.yaml). Review the eight bot scopes and create the app. Install it to that workspace from **OAuth & Permissions**, which then shows its **Bot User OAuth Token** (`xoxb-...`). Under **Basic Information > App-Level Tokens**, generate an app-level token (`xapp-...`) with `connections:write`. The manifest already enables Socket Mode, so no public Request URL is needed. Do not enable token rotation.

2. **Install the CLI.** From a Git checkout of this repository, run:

   ```sh
   bun install && bun link
   ```

   This puts `toy-box-slack` in `~/.bun/bin`, pointing at the checkout, so keep the checkout in place.

3. **Start the bridge.** Run `toy-box-slack serve` and keep it running. The first time, it asks for both tokens and for a passphrase you choose, typed twice. Paste the tokens only there, never into Toy Box, Slack or the repository. Nothing you type is shown. `link`, `allow` and `resume` ask for the passphrase before they widen who can make the lead act, so make it strong and unique, and never put it in Toy Box or Slack. Each time it starts, `serve` installs the skill leads learn the CLI from, and names the file.

4. **Link the channels.** Invite the app into the Slack channel with `/invite` and select **Toy Box**. Open <http://127.0.0.1:3000> and create a channel with a Copilot lead (tested with `claude-sonnet-5`). To use a lead that was already running instead, ask it to read the file `serve` named, since Copilot reads skills when a lead's session starts or resumes. Copy the Slack channel ID from the bottom of its details and the allowed people's member IDs from their profiles, then ask the lead to set up Slack for those IDs. It creates its inbox routine and prints the exact `link` and `allow` commands. Run them yourself in another terminal, and review each preview before you enter the passphrase. Their forms are:

   ```sh
   toy-box-slack link --channel TOYBOX_ID --slack-channel SLACK_ID
   toy-box-slack allow --channel TOYBOX_ID USER_ID
   ```

Defaults are `--requests mention --observe requesters`; `--requests all` accepts any allowed person's top-level post, and `--observe channel` lets a digest read other people's text too. Ask the lead for opt-in digest or release-note routines if wanted.

Send a **new** mention by selecting the app in Slack's mention menu. An allowed person's question should get eyes and one threaded answer within minutes. If it does not, check `toy-box-slack status` and the [operations guide](docs/operations.md).

## Keep it running

The bridge answers only while `serve` runs. Ctrl-C stops it. When `serve` runs again, it catches up on what it missed, within the [limits](docs/operations.md#deletion-and-limits) of catch-up. To start it at login instead, see [operations](docs/operations.md#start-the-bridge-at-login).

`serve` keeps the tokens and the passphrase's hash in `~/.toy-box-slack/credentials.env`, which only you can read. The bridge reads this file, not a checkout `.env`, and environment variables of the same names override it. `TOY_BOX_SLACK_HOME` selects another data folder, and `TOY_BOX_URL` a Toy Box other than <http://127.0.0.1:3000>. `toy-box-slack passphrase` changes the passphrase, given the old one, without a restart.

## Commands and development

**Lead:** `inbox`, `reply`, `dismiss`, `activity`, `mark-read`, `publish`, `retract`. **Owner:** `passphrase`, `link`, `allow`, `resume`. **Lead or terminal:** `status`, `deny`, `pause`, `unlink`. **Operator:** `serve`.

`toy-box-slack <command> --help` gives flags. See [operations](docs/operations.md) for status, pauses, uncertain posts, deletion and starting at login, [AGENTS.md](AGENTS.md) for architecture, and [research](docs/research) for evidence.

Run `bun run check` and `bun test`. `bun install` enables the pre-commit hook in `.githooks`.
