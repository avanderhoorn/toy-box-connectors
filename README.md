# toy-box-slack

toy-box-slack lets a [Toy Box](https://github.com/lostintangent/toy-box) channel's lead watch one Slack channel and act on it. People the channel's owner allows can mention the bot with questions and requests, and the lead answers them in their Slack thread. The lead can also publish updates such as daily or weekly release notes, and bring Slack activity into its Toy Box channel for discussion.

It runs as one local bridge process next to Toy Box. The bridge holds the Slack connection and a SQLite ledger, and the lead works through the `toy-box-slack` CLI. [AGENTS.md](AGENTS.md) explains the architecture, and [docs/research](docs/research) holds the Toy Box and Slack research behind it.

## Development

```sh
bun install
bun run check
bun test
```

`bun install` points git at `.githooks`, whose pre-commit hook lints and formats staged files.
