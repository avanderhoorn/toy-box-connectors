import { BridgeRefusedError } from "@bridge/server/refusal";
import type { SecretReader } from "./secrets";

/** What `serve` and `add-app` ask for an added app's two tokens. */
export const asksBotTokenOf = (app: string) =>
  `Paste the ${app} app's Slack bot token (xoxb-...): `;
export const asksAppTokenOf = (app: string) =>
  `Paste the ${app} app's Slack app-level token (xapp-...): `;

/** The owner at a terminal, answering each prompt with the next of `answers`, null for none. */
export function owner(...answers: (string | null)[]) {
  const typing = {
    asked: [] as string[],
    opened: 0,
    closed: 0,
    reader: (): SecretReader => {
      typing.opened++;
      return {
        read: async (prompt) => {
          typing.asked.push(prompt);
          return answers.shift() ?? null;
        },
        close: () => typing.closed++,
      };
    },
  };
  return typing;
}

/** The whole message `asking` refuses with. */
export async function refusalOf(asking: Promise<unknown>): Promise<string> {
  try {
    await asking;
  } catch (error) {
    if (error instanceof BridgeRefusedError) return error.message;
    throw error;
  }
  throw new Error("Expected a refusal.");
}
