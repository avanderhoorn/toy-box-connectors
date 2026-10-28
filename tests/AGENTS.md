# Tests

Tests prove the bridge's contracts at the layer that can observe them. Unit tests sit next to their source files and cover pure policy: classification, the request lifecycle, wake decisions, rendering and secret checks, `ts` comparison, caller resolution, presenters, and publication periods. The suites here cover what only a running bridge can show.

- `integration/` runs the bridge against protocol fakes of Socket Mode, the Slack Web API, and Toy Box, with no network, ephemeral ports, and short temp folders. A suite spawns the real bridge process when it proves startup, shutdown or wiring, and drives the bridge's server modules in-process when it injects a clock or short timings. `bun test` runs it with the unit tests.
- `e2e/` runs a real, isolated Toy Box with a cheap model, the real bridge and CLI, and fake Slack. It runs only with `TOY_BOX_SLACK_E2E=1`, with Toy Box under a temp `HOME` on port 3199.
- `fakes/` holds the protocol-faithful fakes both suites share. A fake reproduces what the real service does on the wire, including its failures, and nothing more.

The live checklist runs by hand in the real test workspace with the test app's tokens, and its results go to the Toy Box channel.

Unix socket paths must stay under 104 bytes, and macOS temp folders are long, so tests that bind a socket create their folders under `/tmp` with short names. Give every test its own data folder and close every database it opens.
