// What the bridge reads from its environment.
//
// The operator keeps the bridge's settings and the default app's Slack tokens in `credentials.env`
// in the data folder, and a variable set in the environment wins over that file. Each added app
// keeps only its own two tokens, in a `credentials.env` in its folder, which no variable overrides.
// Every setting is checked before the bridge takes any lock, so a bad one stops it before it
// starts. No message repeats a token. The owner's passphrase hash is read from the file alone,
// each time the bridge checks a passphrase. Only tests set SLACK_API_URL and the wake timings: one
// points the Slack clients at a fake, and the other shortens timings so a scenario doesn't wait
// minutes for a reminder.

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { parseLoopbackUrl } from "@/shared/loopback";
import { defaultWakeTimings, wakeTimingsSchema, type WakeTimings } from "@wakes/model";
import { BridgeRefusedError } from "./refusal";

/** Toy Box's own default address. */
const DEFAULT_TOY_BOX_URL = "http://127.0.0.1:3000";

const tokenSettings = {
  SLACK_BOT_TOKEN: z.string().optional().describe("The token the bridge reads and posts with."),
  SLACK_APP_TOKEN: z.string().optional().describe("The token that opens Socket Mode."),
};

const credentialsSchema = z
  .object({
    ...tokenSettings,
    TOY_BOX_URL: z.string().optional().describe("The Toy Box whose leads the bridge wakes."),
    OWNER_PASSPHRASE_HASH: z
      .string()
      .startsWith("$argon2id$")
      .optional()
      .describe("The owner's passphrase as `toy-box-slack passphrase` hashed it."),
  })
  .strict()
  .describe("What the data folder's credentials.env may set, one NAME=value a line.");

const appCredentialsSchema = z
  .object(tokenSettings)
  .strict()
  .describe(
    "What an added app's credentials.env may set, since every other setting is the bridge's.",
  );

/** The settings the data folder's `credentials.env` holds. */
export type Credentials = z.infer<typeof credentialsSchema>;

/** The tokens an added app's `credentials.env` holds. */
export type AppCredentials = z.infer<typeof appCredentialsSchema>;

/** What the bridge needs to reach Toy Box, and Slack for every app. */
export interface BridgeSettings {
  /** The Toy Box whose leads the bridge wakes. */
  toyBoxOrigin: URL;
  /** SLACK_API_URL, the fake Slack a test points both Slack clients at, or undefined for Slack. */
  slackApiUrl: string | undefined;
  wakeTimings: WakeTimings;
}

/** The bridge's settings from `env`, falling back to `credentials` for what `env` leaves unset. */
export function resolveBridgeSettings(
  env: NodeJS.ProcessEnv,
  credentials: Credentials,
): BridgeSettings {
  const toyBoxUrl = env.TOY_BOX_URL || credentials.TOY_BOX_URL || DEFAULT_TOY_BOX_URL;
  const toyBoxOrigin = parseLoopbackUrl(toyBoxUrl);
  if (!toyBoxOrigin) {
    throw new BridgeRefusedError(
      `TOY_BOX_URL must be an http URL on this Mac, such as ${DEFAULT_TOY_BOX_URL}, but it's "${toyBoxUrl}".`,
    );
  }
  return {
    toyBoxOrigin,
    slackApiUrl: env.SLACK_API_URL || undefined,
    wakeTimings: resolveWakeTimings(env.TOY_BOX_SLACK_WAKE_TIMINGS),
  };
}

/**
 * Reads `credentials.env` in `dataFolder`, or nothing when there's no such file. Refuses a file
 * others could read or write, and a setting the bridge doesn't know.
 */
export function readCredentialsFile(dataFolder: string): Credentials {
  return readSettingsFile(credentialsPath(dataFolder), credentialsSchema);
}

/**
 * Reads the `credentials.env` in an added app's `folder`, or nothing when there's no such file.
 * Refuses a file others could read or write, and a setting other than the app's two tokens.
 */
export function readAppCredentialsFile(folder: string): AppCredentials {
  return readSettingsFile(credentialsPath(folder), appCredentialsSchema);
}

/** Sets `name` in the `credentials.env` in `folder`, keeping its other lines, at mode 600. */
export function writeCredential(folder: string, name: keyof Credentials, value: string): void {
  const path = credentialsPath(folder);
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const kept = lines.filter((line) => line.trim() && !line.startsWith(`${name}=`));
  writeFileSync(`${path}.tmp`, [...kept, `${name}=${value}`, ""].join("\n"), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** The `credentials.env` in `folder`. */
export function credentialsPath(folder: string): string {
  return join(folder, "credentials.env");
}

/**
 * The settings `schema` reads from the file at `path`, where no file reads as an empty one. Refuses
 * a file others could read or write, and one that sets anything `schema` doesn't name.
 */
function readSettingsFile<Schema extends z.ZodObject>(
  path: string,
  schema: Schema,
): z.output<Schema> {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return schema.parse({});
    throw error;
  }
  if (mode & 0o077) {
    throw new BridgeRefusedError(
      `${path} has mode ${mode.toString(8)}, but it holds Slack tokens, so it must be 600. Run \`chmod 600 ${path}\` and start the bridge again.`,
    );
  }

  const settings = schema.safeParse(parseEnv(readFileSync(path, "utf8")));
  if (!settings.success) {
    const names = Object.keys(schema.shape);
    throw new BridgeRefusedError(
      `${path} may set only ${names.slice(0, -1).join(", ")} and ${names.at(-1)}.\n${z.prettifyError(settings.error)}`,
    );
  }
  return settings.data;
}

/** The wake timings, with any that `TOY_BOX_SLACK_WAKE_TIMINGS` sets as a JSON object. */
function resolveWakeTimings(value: string | undefined): WakeTimings {
  if (!value) return defaultWakeTimings;
  return { ...defaultWakeTimings, ...wakeTimingsSchema.partial().parse(JSON.parse(value)) };
}
