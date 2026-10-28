// What the bridge reads from its environment.
//
// The operator keeps the Slack tokens in `credentials.env` in the data folder, and a variable set
// in the environment wins over the file. Every setting is checked before the bridge takes its
// lock, so a bad one refuses to start with a message that names it. No message repeats a token.
// Only tests set SLACK_API_URL and the wake timings: one points the Slack clients at a fake, and
// the other shortens timings so a scenario doesn't wait minutes for a reminder.

import { readFileSync, statSync, type Stats } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseLoopbackUrl } from "@/shared/loopback";
import { defaultWakeTimings, wakeTimingsSchema, type WakeTimings } from "@wakes/model";
import { BridgeRefusedError } from "./refusal";

/** Toy Box's own default address. */
const DEFAULT_TOY_BOX_URL = "http://127.0.0.1:3000";

/** The settings `credentials.env` may hold. */
const credentialNames = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "TOY_BOX_URL"] as const;
type CredentialName = (typeof credentialNames)[number];

/** The settings `credentials.env` holds. */
export type Credentials = Partial<Record<CredentialName, string>>;

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

const wakeTimingsOverrideSchema = wakeTimingsSchema.partial();

/** The bridge's settings from `env`, falling back to `credentials` for what `env` leaves unset. */
export function resolveBridgeSettings(
  env: NodeJS.ProcessEnv,
  credentials: Credentials,
): BridgeSettings {
  const setting = (name: CredentialName) => env[name] || credentials[name] || undefined;
  return {
    toyBoxOrigin: resolveToyBoxOrigin({ TOY_BOX_URL: setting("TOY_BOX_URL") }),
    botToken: setting("SLACK_BOT_TOKEN") ?? null,
    appToken: setting("SLACK_APP_TOKEN") ?? null,
    slackApiUrl: resolveSlackApiUrl(env),
    wakeTimings: resolveWakeTimings(env),
  };
}

/** The Toy Box whose leads the bridge wakes: `TOY_BOX_URL`, or Toy Box's default address. */
export function resolveToyBoxOrigin(env: NodeJS.ProcessEnv = process.env): URL {
  const value = env.TOY_BOX_URL || DEFAULT_TOY_BOX_URL;
  const origin = parseLoopbackUrl(value);
  if (!origin) {
    throw new BridgeRefusedError(
      `TOY_BOX_URL must be an http URL on this Mac, such as ${DEFAULT_TOY_BOX_URL}, but it's "${value}".`,
    );
  }
  return origin;
}

/** The wake timings, with any that `TOY_BOX_SLACK_WAKE_TIMINGS` sets as a JSON object. */
export function resolveWakeTimings(env: NodeJS.ProcessEnv = process.env): WakeTimings {
  const value = env.TOY_BOX_SLACK_WAKE_TIMINGS;
  if (!value) return defaultWakeTimings;
  const overrides = wakeTimingsOverrideSchema.safeParse(parseJson(value));
  if (!overrides.success) {
    throw new BridgeRefusedError(
      `TOY_BOX_SLACK_WAKE_TIMINGS must be a JSON object of wake timings in milliseconds.\n${z.prettifyError(overrides.error)}`,
    );
  }
  return { ...defaultWakeTimings, ...overrides.data };
}

/**
 * Reads `credentials.env` in `dataFolder`, or nothing when there's no such file. Refuses a file
 * someone else could read or write, and any line the bridge can't read for certain.
 */
export function readCredentialsFile(dataFolder: string): Credentials {
  const path = join(dataFolder, "credentials.env");
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }

  const problem = credentialsFileProblem(path, stats, userInfo().uid);
  if (problem) throw new BridgeRefusedError(problem);
  return parseCredentials(path, readFileSync(path, "utf8"));
}

/** Explains why the bridge won't read `path` for its tokens, or returns null when it will. */
export function credentialsFileProblem(
  path: string,
  stats: Pick<Stats, "isFile" | "mode" | "uid">,
  uid: number,
): string | null {
  if (!stats.isFile()) {
    return `${path} isn't a file. Keep the Slack tokens in a file only you can read.`;
  }
  if (stats.uid !== uid) {
    return `${path} belongs to another user. Keep the Slack tokens in a file you own.`;
  }

  const mode = stats.mode & 0o777;
  if (mode & 0o077) {
    return `${path} has mode ${mode.toString(8)}, but it holds Slack tokens, so it must be 600. Run \`chmod 600 ${path}\` and start the bridge again.`;
  }
  return null;
}

/**
 * The settings in `text`, one `NAME=value` a line, where `export` before a name, quotes around a
 * value, blank lines and `#` comments are allowed. Refuses anything else.
 */
export function parseCredentials(path: string, text: string): Credentials {
  const credentials: Credentials = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const content = line.trim();
    if (!content || content.startsWith("#")) continue;

    const refuse = (problem: string) =>
      new BridgeRefusedError(`Line ${index + 1} of ${path} ${problem}`);
    const separator = content.indexOf("=");
    if (separator === -1) throw refuse("isn't NAME=value.");
    const name = content
      .slice(0, separator)
      .replace(/^export\s+/, "")
      .trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) throw refuse("isn't NAME=value.");
    if (!isCredentialName(name)) {
      throw refuse(`sets ${name}, but the file may set only ${credentialNames.join(", ")}.`);
    }
    if (name in credentials) throw refuse(`sets ${name} again.`);

    const value = unquote(content.slice(separator + 1).trim());
    if (value === undefined)
      throw refuse(`opens a quote around ${name}'s value without closing it.`);
    if (/\s/.test(value)) {
      throw refuse(`gives ${name} a value with a space in it, which no token or URL has.`);
    }
    credentials[name] = value;
  }
  return credentials;
}

function isCredentialName(name: string): name is CredentialName {
  return (credentialNames as readonly string[]).includes(name);
}

// A value is bare or wrapped whole in matching quotes, so an unmatched quote is undefined.
function unquote(value: string): string | undefined {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value;
  return value.length >= 2 && value.endsWith(quote) ? value.slice(1, -1) : undefined;
}

/** SLACK_API_URL, which only tests set, after the same loopback check as Toy Box's address. */
function resolveSlackApiUrl(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.SLACK_API_URL;
  if (!value) return undefined;
  if (!parseLoopbackUrl(value)) {
    throw new BridgeRefusedError(
      `SLACK_API_URL is only for tests and must be an http URL on this Mac, but it's "${value}".`,
    );
  }
  return value;
}

// Text that isn't JSON fails the schema as a string, which says what was expected.
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
