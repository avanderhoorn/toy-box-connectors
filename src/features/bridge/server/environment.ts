// What the bridge reads from its environment.
//
// Each setting is checked before the bridge touches its data folder, so a bad one refuses to start
// with a message that names it. Only tests set wake timings, which they shorten so a scenario
// doesn't wait minutes for a reminder.

import { z } from "zod";
import { parseLoopbackUrl } from "@/shared/loopback";
import { defaultWakeTimings, wakeTimingsSchema, type WakeTimings } from "@wakes/model";
import { BridgeRefusedError } from "./refusal";

/** Toy Box's own default address. */
const DEFAULT_TOY_BOX_URL = "http://127.0.0.1:3000";

const wakeTimingsOverrideSchema = wakeTimingsSchema.partial();

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

// Text that isn't JSON fails the schema as a string, which says what was expected.
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
