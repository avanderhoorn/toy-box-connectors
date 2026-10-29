// The data folder.
//
// The control socket and every app's database, lock and tokens live in one
// folder that only its owner can open, so the folder's mode is the local trust
// boundary. The bridge and every CLI command resolve it the same way.

import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeRefusedError } from "./refusal";

/** Names the data folder: `TOY_BOX_SLACK_HOME` when it's set, and `~/.toy-box-slack` otherwise. */
export function resolveDataFolder(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.TOY_BOX_SLACK_HOME || join(home, ".toy-box-slack");
}

/** Creates the data folder when it's missing, and refuses one that someone else could open. */
export function prepareDataFolder(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  requirePrivateFolder(path, "The data folder");
}

/** Refuses the folder at `path`, which `what` names, when someone else could open it. */
export function requirePrivateFolder(path: string, what: string): void {
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o700) {
    throw new BridgeRefusedError(
      `${what} ${path} has mode ${mode.toString(8)}, but it must be 700 so only you can open it. Run \`chmod 700 ${path}\` and start the bridge again.`,
    );
  }
}
