// Only the owner widens access. A command that would answers with what it would change, which the
// CLI shows before it asks for the passphrase, and applies the change only when it's still that.

import { CommandRefusedError, type CommandAnswer } from "@commands/model/protocol";

const NO_PASSPHRASE =
  "No passphrase is set, so nothing can widen access. The owner sets one with `toy-box-slack passphrase` at their own terminal.";

/** Refuses `passphrase` unless it's the owner's, given their passphrase's argon2id `hash`. */
export async function checkOwner(passphrase: string, hash: string | null): Promise<void> {
  if (hash === null) throw new CommandRefusedError(NO_PASSPHRASE);
  if (!(await Bun.password.verify(passphrase, hash))) {
    throw new CommandRefusedError("That isn't the owner's passphrase, so nothing changed.");
  }
}

/** What a command answers before it widens access as `preview` shows, or null once it's confirmed. */
export function confirmWidening(
  preview: string,
  confirmed: string | undefined,
): CommandAnswer | null {
  const name = new Bun.CryptoHasher("sha256").update(preview).digest("hex");
  if (confirmed === name) return null;
  if (confirmed !== undefined) {
    throw new CommandRefusedError(
      "What this would change isn't what you were shown anymore, so nothing changed. Run it again to see what it would change now.",
    );
  }
  return { result: null, text: preview, confirm: name };
}
