// The apps in a data folder.
//
// The data folder holds the default app's files, and `apps/` holds a folder for each app the owner
// added, with its own `credentials.env`, `bridge.db` and lock. The folders are the only record of
// which apps there are, so adding an app is making its folder and removing one is deleting it.
// Anything in `apps/` that isn't a folder is ignored, since Finder writes `.DS_Store` there. A
// folder whose name can't name an app, or that others could open, stops the bridge before it takes
// any lock, since only the owner's own edit makes one, and they see why the moment they restart.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { addedAppNameProblem, DEFAULT_APP } from "@bridge/model/apps";
import { requirePrivateFolder } from "./dataFolder";
import { credentialsPath, readAppCredentialsFile, readCredentialsFile } from "./environment";
import { BridgeRefusedError } from "./refusal";

/** Where one app keeps its files. */
export interface App {
  /** `default`, or the name of its folder in `apps/`. */
  name: string;
  /** The data folder for `default`, and the app's folder in `apps/` otherwise. */
  folder: string;
  /** Its `credentials.env`. */
  credentials: string;
  /** Its `bridge.db`. */
  database: string;
  /** Its `bridge.lock`, which lets one bridge at a time open its `bridge.db`. */
  lock: string;
}

/** An app's Slack tokens, each null when nothing sets it. */
export type AppTokens = { botToken: string | null; appToken: string | null };

/**
 * The apps in `dataFolder`: `default` first, then each folder in `apps/` by name. Refuses a folder
 * there whose name can't name an app, or that others could open.
 */
export function listApps(dataFolder: string): App[] {
  const folder = join(dataFolder, "apps");
  const added = readFolder(folder)
    .filter((name) => statSync(join(folder, name), { throwIfNoEntry: false })?.isDirectory())
    .sort()
    .map((name) => {
      const problem = addedAppNameProblem(name);
      if (problem !== null) {
        throw new BridgeRefusedError(
          `${join(folder, name)} can't be an app's folder. ${problem} Rename it or move it out of ${folder}, and start the bridge again.`,
        );
      }
      const app = locateApp(dataFolder, name);
      requirePrivateFolder(app.folder, "The app folder");
      return app;
    });
  return [locateApp(dataFolder, DEFAULT_APP), ...added];
}

/** Where the app named `name` keeps its files in `dataFolder`, whether or not it's there yet. */
export function locateApp(dataFolder: string, name: string): App {
  const folder = name === DEFAULT_APP ? dataFolder : join(dataFolder, "apps", name);
  return {
    name,
    folder,
    credentials: credentialsPath(folder),
    database: join(folder, "bridge.db"),
    lock: join(folder, "bridge.lock"),
  };
}

/**
 * The app's Slack tokens from its `credentials.env`. The environment's apply to `default` only, and
 * win over its file. Refuses a file others could read or write, and an added app's that sets
 * anything but its two tokens.
 */
export function readAppTokens(app: App, env: NodeJS.ProcessEnv): AppTokens {
  if (app.name !== DEFAULT_APP) {
    const file = readAppCredentialsFile(app.folder);
    return { botToken: file.SLACK_BOT_TOKEN || null, appToken: file.SLACK_APP_TOKEN || null };
  }
  const file = readCredentialsFile(app.folder);
  return {
    botToken: env.SLACK_BOT_TOKEN || file.SLACK_BOT_TOKEN || null,
    appToken: env.SLACK_APP_TOKEN || file.SLACK_APP_TOKEN || null,
  };
}

/** The names in the folder at `path`, or none when there's no such folder. */
function readFolder(path: string): string[] {
  try {
    return readdirSync(path);
  } catch (error) {
    switch ((error as NodeJS.ErrnoException).code) {
      case "ENOENT":
        return [];
      case "ENOTDIR":
        throw new BridgeRefusedError(
          `${path} must be the folder that holds the apps \`toy-box-slack add-app\` adds, but it's a file. Move it away and start the bridge again.`,
        );
      default:
        throw error;
    }
  }
}
