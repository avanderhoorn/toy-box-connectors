// The CLI reads the Slack tokens `serve` and `add-app` ask for from the owner's terminal without
// showing them, so they're never in a command line, which other processes can read.

import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { resolveSessionId } from "@commands/model/callers";

/** Whether the owner runs the CLI at a terminal, not a lead, whose shell can be a terminal too. */
export function isOwnerAtTerminal(): boolean {
  return process.stdin.isTTY === true && resolveSessionId(process.env) === null;
}

/** Reads what the owner types a line at a time without showing it. */
export interface SecretReader {
  /** Shows `prompt`, then reads a line, or null on an empty line, at the end of input or on Ctrl-C. */
  read(prompt: string): Promise<string | null>;
  close(): void;
}

/** Reads from the terminal. */
export function secretReader(): SecretReader {
  const lines = createInterface({
    input: process.stdin,
    // What the owner types goes nowhere, so the terminal doesn't show it.
    output: new Writable({ write: (_chunk, _encoding, done) => done() }),
    terminal: true,
  });
  lines.on("SIGINT", () => lines.close());
  const next = lines[Symbol.asyncIterator]();
  return {
    async read(prompt) {
      process.stderr.write(prompt);
      const line = await next.next();
      process.stderr.write("\n");
      return line.done ? null : line.value || null;
    },
    close: () => lines.close(),
  };
}
