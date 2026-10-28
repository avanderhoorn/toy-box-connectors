// The CLI reads the owner's passphrase from the terminal without showing it, or else a line at a
// time from stdin, so it's never in a command line, which other processes can read.

import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import { readCredentialsFile, writeCredential } from "@bridge/server/environment";
import { BridgeRefusedError } from "@bridge/server/refusal";

/** Reads lines, each null at the end of stdin, on an empty line or on Ctrl-C. */
export function passphraseReader() {
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
    async read(prompt: string): Promise<string | null> {
      if (terminal) process.stderr.write(prompt);
      const line = await next.next();
      if (terminal) process.stderr.write("\n");
      return line.done ? null : line.value || null;
    },
    close: () => lines.close(),
  };
}

/** Sets the owner's passphrase, or changes it given the old one, and returns the exit code. */
export async function setPassphrase(dataFolder: string): Promise<number> {
  const reader = passphraseReader();
  try {
    prepareDataFolder(dataFolder);
    const hash = readCredentialsFile(dataFolder).OWNER_PASSPHRASE_HASH;
    const old = hash ? await reader.read("The owner's passphrase now: ") : null;
    if (hash && (old === null || !(await Bun.password.verify(old, hash)))) {
      return refused(
        "That isn't the owner's passphrase, so nothing changed. If it's forgotten, delete the OWNER_PASSPHRASE_HASH line from credentials.env and run this again.",
      );
    }
    const passphrase = await reader.read("The new passphrase: ");
    if (!passphrase) return refused("The new passphrase is empty, so nothing changed.");
    if ((await reader.read("The new passphrase again: ")) !== passphrase) {
      return refused("The two passphrases differ, so nothing changed.");
    }
    const newHash = await Bun.password.hash(passphrase, "argon2id");
    writeCredential(dataFolder, "OWNER_PASSPHRASE_HASH", newHash);
    console.log("Set the owner's passphrase.");
    return 0;
  } catch (error) {
    if (!(error instanceof BridgeRefusedError)) throw error;
    return refused(error.message);
  } finally {
    reader.close();
  }
}

function refused(message: string): 1 {
  console.error(message);
  return 1;
}
