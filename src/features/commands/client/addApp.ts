// Adding an app.
//
// The owner adds an app at their own terminal by naming it and pasting its two tokens, which
// `add-app` saves in a folder of its own in `apps/`, where the bridge finds it the next time it
// starts. It asks before it creates that folder, so an owner who stops at a prompt leaves no app
// behind, and it only ever creates a folder, so it can't change an app that's already there. It
// never talks to Slack, since the bridge checks the tokens when it starts. If it stops part way
// through saving, `serve` asks for whatever token the folder lacks, as it does for any app.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { addedAppNameProblem } from "@bridge/model/apps";
import { listApps, locateApp, type App } from "@bridge/server/apps";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import { writeCredential } from "@bridge/server/environment";
import { BridgeRefusedError } from "@bridge/server/refusal";
import { resolveSessionId } from "@commands/model/callers";
import { log } from "@/shared/log";
import { askForToken, TOKENS, type Token } from "./firstRun";
import { secretReader, type SecretReader } from "./secrets";

/** Adds the `name` app at the owner's terminal, says how to start it, and returns the exit code. */
export async function addApp(dataFolder: string, name: string): Promise<number> {
  // Only the owner pastes an app's tokens, never a lead, whose shell can be a terminal too.
  if (!process.stdin.isTTY || resolveSessionId(process.env) !== null) {
    log("Only the owner at a terminal runs `add-app`.");
    return 1;
  }
  try {
    const app = await createAppFolder(dataFolder, name);
    console.log(`Added the ${app.name} app in ${app.folder}.`);
    console.log(
      `The bridge starts it when the bridge next starts. If the bridge is running, restart it: press Ctrl-C where \`toy-box-slack serve\` runs and run that again, or if it starts at login, run \`launchctl kickstart -k "gui/$(id -u)/local.toy-box-slack"\`.`,
    );
    console.log(
      `Then link a Toy Box channel through it with \`toy-box-slack link --channel TOYBOX_ID --slack-channel SLACK_ID --app ${app.name}\`.`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof BridgeRefusedError)) throw error;
    log(error.message);
    return 1;
  }
}

/**
 * Asks the owner for both Slack tokens of a new app named `name`, then creates its folder in
 * `dataFolder` holding them. Refuses, before asking anything, a name an added app can't have,
 * anything already where its folder goes, a data folder others could open, and an `apps/` or a
 * folder in it that would stop the bridge. Refuses an answer that isn't there or isn't a token,
 * creating nothing.
 */
export async function createAppFolder(
  dataFolder: string,
  name: string,
  openReader: () => SecretReader = secretReader,
): Promise<App> {
  const problem = addedAppNameProblem(name);
  if (problem !== null) {
    throw new BridgeRefusedError(`${problem} Run add-app again with another name.`);
  }
  prepareDataFolder(dataFolder);
  // Only for its refusals, so the owner hears of a folder that stops the bridge before typing.
  listApps(dataFolder);
  const app = locateApp(dataFolder, name);
  if (existsSync(app.folder)) throw alreadyThere(app);

  const answers: [Token["name"], string][] = [];
  const reader = openReader();
  try {
    for (const token of TOKENS) {
      const answer = await askForToken(reader, name, token);
      if (answer === null) {
        throw new BridgeRefusedError(
          `No ${token.kind} was given, so add-app didn't add the ${name} app.`,
        );
      }
      answers.push([token.name, answer]);
    }
  } finally {
    reader.close();
  }

  mkdirSync(join(dataFolder, "apps"), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(app.folder, { mode: 0o700 });
  } catch (error) {
    // It appeared while the owner typed, so whatever made it keeps it.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw alreadyThere(app);
    throw error;
  }
  for (const [token, answer] of answers) writeCredential(app.folder, token, answer);
  return app;
}

function alreadyThere(app: App): BridgeRefusedError {
  return new BridgeRefusedError(
    `${app.folder} is already there, so add-app didn't add the ${app.name} app. To replace one of its tokens, delete that token's line from ${app.credentials} and run \`toy-box-slack serve\` at a terminal, which asks for it again.`,
  );
}
