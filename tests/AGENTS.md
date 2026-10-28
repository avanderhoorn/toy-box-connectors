# Tests

Tests prove the bridge's contracts at the layer that can observe them. Unit tests sit next to their source files and cover pure policy: classification, the request lifecycle, wake decisions, rendering and secret checks, `ts` comparison, caller resolution, presenters, and publication periods. The suites here cover what only a running bridge can show.

- `integration/` runs the bridge against protocol fakes of Socket Mode, the Slack Web API, and Toy Box, with no network, ephemeral ports, and short temp folders. A suite spawns the real bridge process when it proves startup, shutdown or wiring, and drives the bridge's server modules in-process when it injects a clock or short timings. A spawned bridge finds the fake Toy Box through `TOY_BOX_URL` and takes shorter waits from `TOY_BOX_SLACK_WAKE_TIMINGS`, a JSON object of the wake timings to change, in milliseconds. `bun test` runs it with the unit tests.
- `e2e/` runs the built Toy Box with a real Copilot lead on claude-sonnet-5, the real bridge and CLI, and fake Slack. Every run spends model credits, so it runs only with `TOY_BOX_SLACK_E2E=1`, and one run at a time, because Toy Box takes port 3199.
- `fakes/` holds the protocol-faithful fakes both suites share. A fake reproduces what the real service does on the wire, including its failures, and nothing more.

An end-to-end run starts Toy Box under a temp `HOME`, so its database, sessions, skills and Copilot state never touch the owner's. It drops the variables agent shells set, which point at the owner's Toy Box, session and credentials, and its Copilot CLI signs in with the token from `gh auth token`, which goes only into Toy Box's environment. Set `TOY_BOX_BINARY` to run a binary other than the toy-box checkout's. A test channel's purpose rules out members, tasks and wakes its lead schedules, and a test wakes the lead only as the owner or with a routine run, once its last turn has settled. Assert what the lead did through `bridge.db`, the fakes, the commands it ran and its presence, never its words. A failed run keeps its folder, without the Copilot CLI's unpacked caches, and names Toy Box's log and the lead's transcript.

The live checklist runs by hand in the real test workspace with the test app's tokens, and its results go to the Toy Box channel.

Unix socket paths must stay under 104 bytes, and macOS temp folders are long, so tests that bind a socket create their folders under `/tmp` with short names. Give every test its own data folder and close every database it opens.
