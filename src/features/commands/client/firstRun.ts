// When the owner runs `serve` at a terminal, it first asks for each Slack token an app doesn't have.
// The environment's tokens count for the default app only. Each answer is saved in its app's
// credentials.env once it's checked, so running `serve` again asks only for what's still missing,
// and deleting a token's line is how the owner replaces one Slack rejected. Nothing the owner types
// is shown or repeated, and a token must be one word, so it reads back from credentials.env as it
// was typed.

import { DEFAULT_APP } from "@bridge/model/apps";
import { listApps, readAppTokens } from "@bridge/server/apps";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import {
  readCredentialsFile,
  resolveBridgeSettings,
  writeCredential,
} from "@bridge/server/environment";
import { BridgeRefusedError } from "@bridge/server/refusal";
import { secretReader, type SecretReader } from "./secrets";

/** The tokens an app needs, with the setting each fills and what one starts with. */
export const TOKENS = [
  { name: "SLACK_BOT_TOKEN", setting: "botToken", kind: "Slack bot token", prefix: "xoxb-" },
  { name: "SLACK_APP_TOKEN", setting: "appToken", kind: "Slack app-level token", prefix: "xapp-" },
] as const;

export type Token = (typeof TOKENS)[number];

/**
 * Asks the owner for each Slack token an app in `dataFolder` is missing, the default app's first,
 * and saves each answer. Says what it saved in each file, the default app's first, or nothing when
 * nothing was missing. Refuses an answer that isn't there or isn't a token, so the bridge doesn't
 * start without it.
 */
export async function askForMissingCredentials(
  dataFolder: string,
  env: NodeJS.ProcessEnv,
  openReader: () => SecretReader = secretReader,
): Promise<string[]> {
  prepareDataFolder(dataFolder);
  // The same checks the bridge makes, so a setting it would refuse stops it before anyone types.
  resolveBridgeSettings(env, readCredentialsFile(dataFolder));
  const apps = listApps(dataFolder)
    .map((app) => {
      const found = readAppTokens(app, env);
      return { app, missing: TOKENS.filter(({ setting }) => !found[setting]) };
    })
    .filter(({ missing }) => missing.length > 0);
  if (apps.length === 0) return [];

  const reader = openReader();
  try {
    for (const { app, missing } of apps) {
      const forApp = app.name === DEFAULT_APP ? "" : ` for the ${app.name} app`;
      for (const token of missing) {
        const answer = await askForToken(reader, app.name, token);
        if (answer === null) {
          throw new BridgeRefusedError(
            `No ${token.kind} was given${forApp}, so toy-box-slack didn't start.`,
          );
        }
        writeCredential(app.folder, token.name, answer);
      }
    }
  } finally {
    reader.close();
  }
  // It saved everything it asked for, since a refusal leaves before here.
  return apps.map(({ app, missing }) => {
    const saved = new Intl.ListFormat("en").format(missing.map(({ name }) => name));
    return `Saved ${saved} in ${app.credentials}.`;
  });
}

/**
 * The owner's answer for the `app` app's `token`, asked by the app's name unless it's the default
 * app, or null when they gave none. Refuses an answer that isn't a token.
 */
export async function askForToken(
  reader: SecretReader,
  app: string,
  { kind, prefix }: Token,
): Promise<string | null> {
  const whose = app === DEFAULT_APP ? "" : `${app} app's `;
  const answer = (await reader.read(`Paste the ${whose}${kind} (${prefix}...): `))?.trim();
  if (!answer) return null;
  if (!new RegExp(`^${prefix}[\\w-]+$`).test(answer)) {
    throw new BridgeRefusedError(
      `That isn't a ${kind}, which is one word starting with ${prefix}, so it wasn't saved.`,
    );
  }
  return answer;
}
