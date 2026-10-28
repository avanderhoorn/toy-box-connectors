# toy-box-slack

One local bridge lets a [Toy Box](https://github.com/lostintangent/toy-box) channel's Copilot lead answer allowed people in one Slack channel, publish scheduled release notes there, and bring useful activity back to Toy Box.

The four v1 guarantees are: only allowlisted people can open requests, only the owner widens access, uncertain posts are never resent, and events survive acknowledgement with gaps recovered or reported. Rare channel or policy changes pause the link until the owner resumes it. **Prototype:** history catch-up and ledger retention are still being completed on main.

No DMs, attachments, Slack Connect, org-wide installs, rotating tokens or non-Copilot leads. Slack text the lead reads reaches Copilot and its selected model provider. Obtain company approval first and read the [reviewer guide](docs/security-review.md).

## Install on a Mac

Install [Git](https://git-scm.com/download/mac), [Node 24](https://nodejs.org/en/download) and [Bun](https://bun.com/docs/installation) (tested with 1.4.4). From a Git checkout of this repository, with the Mac's default zsh:

```sh
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
printf '%s\n' 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"' >> "$HOME/.zshrc"
npm install --global --prefix "$HOME/.local" @github/copilot @lostintangent/toy-box
bun install
mkdir -p "$HOME/.local/bin"
ln -sf "$PWD/cli/index.ts" "$HOME/.local/bin/toy-box-slack"
toy-box-slack install-skill
```

Run `copilot`, use `/login` to sign in, then exit. Start Toy Box **from this PATH**, so its leads can find the CLI:

```sh
toy-box --host 127.0.0.1
```

Open <http://127.0.0.1:3000> and create a channel with a Copilot lead (tested with `claude-sonnet-5`). Toy Box has no authentication. Never expose it publicly or through a tunnel.

## Create the Slack app

At <https://api.slack.com/apps>, choose **Create New App > From a manifest**, choose the approved workspace, and paste [docs/manifest.yaml](docs/manifest.yaml). Review the eight bot scopes and create the app. No public Request URL is needed.

Install the app to that workspace from **OAuth & Permissions**, then copy its **Bot User OAuth Token** (`xoxb-...`). Under **Basic Information > App-Level Tokens**, generate an app-level token (`xapp-...`) with `connections:write`. Socket Mode is already enabled by the manifest. Do not enable token rotation.

In another terminal, create the private credential file, then edit it:

```sh
mkdir -p "$HOME/.toy-box-slack"
chmod 700 "$HOME/.toy-box-slack"
touch "$HOME/.toy-box-slack/credentials.env"
chmod 600 "$HOME/.toy-box-slack/credentials.env"
nano "$HOME/.toy-box-slack/credentials.env"
```

Paste the real tokens into these settings, not into Toy Box, Slack or the repository:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
TOY_BOX_URL=http://127.0.0.1:3000
```

The bridge reads this file, not a checkout `.env`; token and URL environment variables override it. These instructions use the default data folder. `TOY_BOX_SLACK_HOME` can select another.

Invite the app into the Slack channel with `/invite` and select **Toy Box**, then run `toy-box-slack serve` in the foreground. Keep it running while configuring the link.

## Link the channels

At your terminal, run `toy-box-slack passphrase` and type a strong, unique passphrase twice. It adds only `OWNER_PASSPHRASE_HASH` to the credential file. Never put the passphrase in Toy Box or Slack. Changing it needs the old one and takes effect without restarting.

Copy the Slack channel ID from the bottom of its details and the allowed people's member IDs from their profiles. In Toy Box, ask the lead to set up Slack for those IDs, create its inbox routine, and print the exact `link` and `allow` commands. Run them yourself at a terminal. Their forms are:

```sh
toy-box-slack link --channel TOYBOX_ID --slack-channel SLACK_ID
toy-box-slack allow --channel TOYBOX_ID USER_ID
toy-box-slack status --channel TOYBOX_ID
```

Replace the IDs with the lead's commands. Review each preview before entering the passphrase. Defaults are `--requests mention --observe requesters`; `--requests all` accepts any allowed person's top-level post, and `--observe channel` lets a digest read other people's text too. Ask the lead for opt-in digest or release-note routines if wanted.

Send a **new** mention by selecting the app in Slack's mention menu. An allowed person's question should get eyes and one threaded answer within minutes. If it does not, check `status` and the [operations guide](docs/operations.md).

## Start the bridge at login

After foreground setup works, stop that bridge with Ctrl-C. From the checkout, generate a per-user [launchd](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) job:

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

This expands absolute paths now because launchd does not expand `~` or shell variables. Keep the checkout in place. The job starts at login, not before login, and does not start Toy Box. Keep Toy Box running separately. Logs are in `~/.toy-box-slack/bridge.log`.

Stop with `launchctl bootout "gui/$(id -u)/local.toy-box-slack"`. After changing credentials, restart with `launchctl kickstart -k "gui/$(id -u)/local.toy-box-slack"`. Do not run a foreground bridge and the job together. The log grows until the operator rotates it.

## Commands and development

**Lead:** `inbox`, `reply`, `dismiss`, `activity`, `mark-read`, `publish`, `retract`. **Owner:** `passphrase`, `link`, `allow`, `resume`. **Lead or terminal:** `status`, `deny`, `pause`, `unlink`. **Operator:** `serve`, `install-skill`.

`toy-box-slack <command> --help` gives flags. See [operations](docs/operations.md) for status, pauses, uncertain posts and deletion, [AGENTS.md](AGENTS.md) for architecture, and [research](docs/research) for evidence.

Run `bun run check` and `bun test`. `bun install` enables the pre-commit hook in `.githooks`.
