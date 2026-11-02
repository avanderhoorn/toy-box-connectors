import { expect } from "bun:test";
import { CommandRefusedError } from "@commands/model/protocol";
import type { SlackState } from "@commands/model/status";

/** What a command said when it refused, failing the test when it answered or broke instead. */
export async function refusal(answer: Promise<unknown>): Promise<string> {
  const error = await answer.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(CommandRefusedError);
  return (error as Error).message;
}

/** Slack's state while the bridge is connected. */
export const connectedSlack = (): SlackState => ({ connection: "connected", problem: null });

/** Slack's state once Slack rejects the bot token, which lasts until the bridge restarts. */
export const rejectedSlack = (): SlackState => ({
  connection: "auth_failed",
  problem: "Slack rejects the bot token.",
});
