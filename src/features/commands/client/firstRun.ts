// The first time the owner runs `serve` at a terminal, it asks for what the bridge is missing: each
// Slack token the environment doesn't set, and the owner's passphrase. It saves each answer once
// it's checked, so running `serve` again asks only for what's still missing. Nothing the owner
// types is shown or repeated, and a token must be one word, so it reads back from credentials.env
// as it was typed.

import { join } from "node:path";
import { DEFAULT_APP } from "@bridge/model/apps";
import { locateApp, readAppTokens } from "@bridge/server/apps";
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

/**
 * Asks the owner for each Slack token and the passphrase the bridge in `dataFolder` is missing,
 * and saves each one, saying what it saved, or null when nothing was missing. Refuses an answer
 * that isn't there or isn't a token, so the bridge doesn't start without it.
 */
export async function askForMissingCredentials(
  dataFolder: string,
  env: NodeJS.ProcessEnv,
  openReader: () => SecretReader = secretReader,
): Promise<string | null> {
  prepareDataFolder(dataFolder);
  const credentials = readCredentialsFile(dataFolder);
  // The same checks the bridge makes, so a setting it would refuse stops it before anyone types.
  resolveBridgeSettings(env, credentials);
  const found = readAppTokens(locateApp(dataFolder, DEFAULT_APP), env);
  const tokens = TOKENS.filter(({ setting }) => !found[setting]);
  const passphrase = !credentials.OWNER_PASSPHRASE_HASH;
  if (tokens.length === 0 && !passphrase) return null;

  const saved: string[] = [];
  const reader = openReader();
  try {
    for (const { name, kind, prefix } of tokens) {
      const token = (await reader.read(`Paste the ${kind} (${prefix}...): `))?.trim();
      if (!token) {
        throw new BridgeRefusedError(`No ${kind} was given, so toy-box-slack didn't start.`);
      }
      if (!new RegExp(`^${prefix}[\\w-]+$`).test(token)) {
        throw new BridgeRefusedError(
          `That isn't a ${kind}, which is one word starting with ${prefix}, so it wasn't saved.`,
        );
      }
      writeCredential(dataFolder, name, token);
      saved.push(name);
    }
    if (passphrase) {
      const prompt = "Choose the owner's passphrase, which link, allow and resume ask for: ";
      await choosePassphrase(reader, dataFolder, prompt);
      saved.push("OWNER_PASSPHRASE_HASH");
    }
  } finally {
    reader.close();
  }
  const list = new Intl.ListFormat("en").format(saved);
  return `Saved ${list} in ${join(dataFolder, "credentials.env")}.`;
}
