// The CLI reads the Slack tokens `serve` and `add-app` ask for from the terminal without showing
// them, or else a line at a time from stdin, so they're never in a command line, which other
// processes can read.

import { createInterface } from "node:readline";
import { Writable } from "node:stream";

/** Reads what the owner types a line at a time without showing it. */
export interface SecretReader {
  /**
   * Shows `prompt` at a terminal, then reads a line, or null at the end of stdin, on an empty line
   * or on Ctrl-C.
   */
  read(prompt: string): Promise<string | null>;
  close(): void;
}

/** Reads from the terminal, or from stdin when it isn't one. */
export function secretReader(): SecretReader {
  const terminal = process.stdin.isTTY === true;
  const lines = createInterface({
    input: process.stdin,
    // What the owner types goes nowhere, so the terminal doesn't show it.
    output: new Writable({ write: (_chunk, _encoding, done) => done() }),
    terminal,
  });
  lines.on("SIGINT", () => lines.close());
  const next = lines[Symbol.asyncIterator]();
  return {
    async read(prompt) {
      if (terminal) process.stderr.write(prompt);
      const line = await next.next();
      if (terminal) process.stderr.write("\n");
      return line.done ? null : line.value || null;
    },
    close: () => lines.close(),
  };
}
