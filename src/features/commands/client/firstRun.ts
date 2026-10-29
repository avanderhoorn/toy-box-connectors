// When the owner runs `serve` at a terminal, it first asks for what the bridge is missing: each Slack
// token an app doesn't have, and the owner's passphrase. The environment's tokens count for the
// default app only. Each answer is saved in its app's credentials.env once it's checked, so running
// `serve` again asks only for what's still missing, and deleting a token's line is how the owner
// replaces one Slack rejected. Nothing the owner types is shown or repeated, and a token must be one
// word, so it reads back from credentials.env as it was typed.

import { DEFAULT_APP } from "@bridge/model/apps";
import { listApps, readAppTokens } from "@bridge/server/apps";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import {
  readCredentialsFile,
  resolveBridgeSettings,
  writeCredential,
} from "@bridge/server/environment";
import { BridgeRefusedError } from "@bridge/server/refusal";
import { choosePassphrase, secretReader, type SecretReader } from "./passphrase";

/** The tokens `serve` asks for, with the setting each fills and what one starts with. */
const TOKENS = [
  { name: "SLACK_BOT_TOKEN", setting: "botToken", kind: "Slack bot token", prefix: "xoxb-" },
  { name: "SLACK_APP_TOKEN", setting: "appToken", kind: "Slack app-level token", prefix: "xapp-" },
] as const;

type Token = (typeof TOKENS)[number];

/**
 * Asks the owner for each Slack token an app in `dataFolder` is missing, the default app's first,
 * then for the passphrase when the bridge has none, and saves each answer. Says what it saved in
 * each file, the default app's first, or nothing when nothing was missing. Refuses an answer that
 * isn't there or isn't a token, so the bridge doesn't start without it.
 */
export async function askForMissingCredentials(
  dataFolder: string,
  env: NodeJS.ProcessEnv,
  openReader: () => SecretReader = secretReader,
): Promise<string[]> {
  prepareDataFolder(dataFolder);
  const credentials = readCredentialsFile(dataFolder);
  // The same checks the bridge makes, so a setting it would refuse stops it before anyone types.
  resolveBridgeSettings(env, credentials);
  const apps = listApps(dataFolder).map((app) => {
    const found = readAppTokens(app, env);
    return { app, missing: TOKENS.filter(({ setting }) => !found[setting]) };
  });
  const passphrase = !credentials.OWNER_PASSPHRASE_HASH;
  if (!passphrase && apps.every(({ missing }) => missing.length === 0)) return [];

  const reader = openReader();
  try {
    for (const { app, missing } of apps) {
      for (const token of missing) {
        writeCredential(app.folder, token.name, await askForToken(reader, app.name, token));
      }
    }
    if (passphrase) {
      const prompt = "Choose the owner's passphrase, which link, allow and resume ask for: ";
      await choosePassphrase(reader, dataFolder, prompt);
    }
  } finally {
    reader.close();
  }
  // It saved everything it asked for, since a refusal leaves before here.
  return apps.flatMap(({ app, missing }) => {
    const saved: string[] = missing.map(({ name }) => name);
    if (passphrase && app.name === DEFAULT_APP) saved.push("OWNER_PASSPHRASE_HASH");
    if (saved.length === 0) return [];
    return [`Saved ${new Intl.ListFormat("en").format(saved)} in ${app.credentials}.`];
  });
}

/**
 * The owner's answer for the `app` app's `token`, asked by the app's name unless it's the default
 * app. Refuses an answer that isn't there or isn't a token.
 */
async function askForToken(
  reader: SecretReader,
  app: string,
  { kind, prefix }: Token,
): Promise<string> {
  const added = app !== DEFAULT_APP;
  const whose = added ? `${app} app's ` : "";
  const answer = (await reader.read(`Paste the ${whose}${kind} (${prefix}...): `))?.trim();
  if (!answer) {
    const forApp = added ? ` for the ${app} app` : "";
    throw new BridgeRefusedError(`No ${kind} was given${forApp}, so toy-box-slack didn't start.`);
  }
  if (!new RegExp(`^${prefix}[\\w-]+$`).test(answer)) {
    throw new BridgeRefusedError(
      `That isn't a ${kind}, which is one word starting with ${prefix}, so it wasn't saved.`,
    );
  }
  return answer;
}
