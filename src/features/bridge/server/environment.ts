// What the bridge reads from its environment.
//
// The operator keeps the Slack tokens in `credentials.env` in the data folder, and a variable set
// in the environment wins over the file. Every setting is checked before the bridge takes its
// lock, so a bad one stops it before it starts. No message repeats a token. The owner's passphrase
// hash is read from the file alone, each time the bridge checks a passphrase. Only tests set
// SLACK_API_URL and the wake timings: one points the Slack clients at a fake, and the other
// shortens timings so a scenario doesn't wait minutes for a reminder.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { parseLoopbackUrl } from "@/shared/loopback";
import { defaultWakeTimings, wakeTimingsSchema, type WakeTimings } from "@wakes/model";
import { BridgeRefusedError } from "./refusal";

/** Toy Box's own default address. */
const DEFAULT_TOY_BOX_URL = "http://127.0.0.1:3000";

const credentialsSchema = z
  .object({
    SLACK_BOT_TOKEN: z.string().optional().describe("The token the bridge reads and posts with."),
    SLACK_APP_TOKEN: z.string().optional().describe("The token that opens Socket Mode."),
    TOY_BOX_URL: z.string().optional().describe("The Toy Box whose leads the bridge wakes."),
    OWNER_PASSPHRASE_HASH: z
      .string()
      .startsWith("$argon2id$")
      .optional()
      .describe("The owner's passphrase as `toy-box-slack passphrase` hashed it."),
  })
  .strict()
  .describe("What credentials.env may set, one NAME=value a line.");

/** The settings `credentials.env` holds. */
export type Credentials = z.infer<typeof credentialsSchema>;

/** What the bridge needs to reach Slack and Toy Box. */
export interface BridgeSettings {
  /** The Toy Box whose leads the bridge wakes. */
  toyBoxOrigin: URL;
  /** SLACK_BOT_TOKEN, or null when neither the environment nor credentials.env sets it. */
  botToken: string | null;
  /** SLACK_APP_TOKEN, or null when neither the environment nor credentials.env sets it. */
  appToken: string | null;
  /** SLACK_API_URL, the fake Slack a test points both Slack clients at, or undefined for Slack. */
  slackApiUrl: string | undefined;
  wakeTimings: WakeTimings;
}

/** The bridge's settings from `env`, falling back to `credentials` for what `env` leaves unset. */
export function resolveBridgeSettings(
  env: NodeJS.ProcessEnv,
  credentials: Credentials,
): BridgeSettings {
  const setting = (name: keyof Credentials) => env[name] || credentials[name] || null;
  const toyBoxUrl = setting("TOY_BOX_URL") ?? DEFAULT_TOY_BOX_URL;
  const toyBoxOrigin = parseLoopbackUrl(toyBoxUrl);
  if (!toyBoxOrigin) {
    throw new BridgeRefusedError(
      `TOY_BOX_URL must be an http URL on this Mac, such as ${DEFAULT_TOY_BOX_URL}, but it's "${toyBoxUrl}".`,
    );
  }
  return {
    toyBoxOrigin,
    botToken: setting("SLACK_BOT_TOKEN"),
    appToken: setting("SLACK_APP_TOKEN"),
    slackApiUrl: env.SLACK_API_URL || undefined,
    wakeTimings: resolveWakeTimings(env.TOY_BOX_SLACK_WAKE_TIMINGS),
  };
}

/**
 * Reads `credentials.env` in `dataFolder`, or nothing when there's no such file. Refuses a file
 * others could read or write, and a setting the bridge doesn't know.
 */
export function readCredentialsFile(dataFolder: string): Credentials {
  const path = credentialsPath(dataFolder);
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (mode & 0o077) {
    throw new BridgeRefusedError(
      `${path} has mode ${mode.toString(8)}, but it holds Slack tokens, so it must be 600. Run \`chmod 600 ${path}\` and start the bridge again.`,
    );
  }

  const credentials = credentialsSchema.safeParse(parseEnv(readFileSync(path, "utf8")));
  if (!credentials.success) {
    throw new BridgeRefusedError(
      `${path} may set only SLACK_BOT_TOKEN, SLACK_APP_TOKEN, TOY_BOX_URL and OWNER_PASSPHRASE_HASH.\n${z.prettifyError(credentials.error)}`,
    );
  }
  return credentials.data;
}

/** Sets `name` in `credentials.env`, keeping its other lines, and leaves the file at mode 600. */
export function writeCredential(dataFolder: string, name: keyof Credentials, value: string): void {
  const path = credentialsPath(dataFolder);
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const kept = lines.filter((line) => line.trim() && !line.startsWith(`${name}=`));
  writeFileSync(`${path}.tmp`, [...kept, `${name}=${value}`, ""].join("\n"), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function credentialsPath(dataFolder: string): string {
  return join(dataFolder, "credentials.env");
}

/** The wake timings, with any that `TOY_BOX_SLACK_WAKE_TIMINGS` sets as a JSON object. */
function resolveWakeTimings(value: string | undefined): WakeTimings {
  if (!value) return defaultWakeTimings;
  return { ...defaultWakeTimings, ...wakeTimingsSchema.partial().parse(JSON.parse(value)) };
}
