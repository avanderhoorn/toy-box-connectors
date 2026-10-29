// The CLI reads the owner's secrets, their passphrase and the Slack tokens `serve` asks for, from
// the terminal without showing them, or else a line at a time from stdin, so they're never in a
// command line, which other processes can read.

import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import { readCredentialsFile, writeCredential } from "@bridge/server/environment";
import { BridgeRefusedError } from "@bridge/server/refusal";
import { resolveSessionId } from "@commands/model/callers";
import { log } from "@/shared/log";

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

/** Sets the owner's passphrase, or changes it given the old one, and returns the exit code. */
export async function setPassphrase(dataFolder: string): Promise<number> {
  // A lead told that no passphrase is set would otherwise choose one, then widen access with it.
  if (resolveSessionId(process.env) !== null) {
    return refused("Only the owner at a terminal runs `passphrase`.");
  }
  const reader = secretReader();
  try {
    prepareDataFolder(dataFolder);
    const hash = readCredentialsFile(dataFolder).OWNER_PASSPHRASE_HASH;
    const old = hash ? await reader.read("The owner's passphrase now: ") : null;
    if (hash && (old === null || !(await Bun.password.verify(old, hash)))) {
      return refused(
        "That isn't the owner's passphrase, so nothing changed. If it's forgotten, delete the OWNER_PASSPHRASE_HASH line from credentials.env and run this again.",
      );
    }
    await choosePassphrase(reader, dataFolder, "The new passphrase: ");
    console.log("Set the owner's passphrase.");
    return 0;
  } catch (error) {
    if (!(error instanceof BridgeRefusedError)) throw error;
    return refused(error.message);
  } finally {
    reader.close();
  }
}

/** Reads a new passphrase after `prompt` and then again, and saves its hash, or refuses. */
export async function choosePassphrase(
  reader: SecretReader,
  dataFolder: string,
  prompt: string,
): Promise<void> {
  const passphrase = await reader.read(prompt);
  if (!passphrase) throw new BridgeRefusedError("The new passphrase is empty, so it wasn't saved.");
  if ((await reader.read("The new passphrase again: ")) !== passphrase) {
    throw new BridgeRefusedError("The two passphrases differ, so neither was saved.");
  }
  const hash = await Bun.password.hash(passphrase, "argon2id");
  writeCredential(dataFolder, "OWNER_PASSPHRASE_HASH", hash);
}

function refused(message: string): 1 {
  log(message);
  return 1;
}
