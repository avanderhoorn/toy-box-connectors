import { expect } from "bun:test";
import { CommandRefusedError } from "@commands/model/protocol";

/** What a command said when it refused, failing the test when it answered or broke instead. */
export async function refusal(answer: Promise<unknown>): Promise<string> {
  const error = await answer.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(CommandRefusedError);
  return (error as Error).message;
}
