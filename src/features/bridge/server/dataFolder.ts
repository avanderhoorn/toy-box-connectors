// The data folder.
//
// The database, the single-bridge lock and the control socket live in one
// folder that only its owner can open, so the folder's mode is the local trust
// boundary. The bridge and every CLI command resolve it the same way.

import { chmodSync, existsSync, mkdirSync, statSync, type Stats } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { BridgeRefusedError } from "./refusal";

/** Names the data folder: `TOY_BOX_SLACK_HOME` when it's set, and `~/.toy-box-slack` otherwise. */
export function resolveDataFolder(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.TOY_BOX_SLACK_HOME;
  if (!configured) return join(home, ".toy-box-slack");

  // launchd starts the bridge in `/` and the lead runs the CLI from anywhere,
  // so a relative path would name a different folder for each of them.
  if (!isAbsolute(configured)) {
    throw new BridgeRefusedError(
      `TOY_BOX_SLACK_HOME must be an absolute path, but it's "${configured}".`,
    );
  }
  return resolve(configured);
}

/** Creates the data folder when it's missing, and refuses one that someone else could open. */
export function prepareDataFolder(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    // mkdir applies the umask, so set the mode the check below requires.
    chmodSync(path, 0o700);
  }

  const problem = dataFolderProblem(path, statSync(path), userInfo().uid);
  if (problem) throw new BridgeRefusedError(problem);
}

/** Explains why `path` can't hold the bridge's data, or returns null when it can. */
export function dataFolderProblem(
  path: string,
  stats: Pick<Stats, "isDirectory" | "mode" | "uid">,
  uid: number,
): string | null {
  if (!stats.isDirectory()) {
    return `${path} isn't a folder, so it can't be the data folder. Set TOY_BOX_SLACK_HOME to a folder you own.`;
  }
  if (stats.uid !== uid) {
    return `The data folder ${path} belongs to another user. Set TOY_BOX_SLACK_HOME to a folder you own.`;
  }

  const mode = stats.mode & 0o777;
  if (mode !== 0o700) {
    return `The data folder ${path} has mode ${mode.toString(8)}, but it must be 700 so only you can open it. Run \`chmod 700 ${path}\` and start the bridge again.`;
  }
  return null;
}
