// The bridge works out who's calling before anything else, so a caller it won't act for learns
// nothing about any channel. Then it parses the input with the command's schema, checks the
// owner's passphrase when the call brings one, and runs it.

import type { z } from "zod";
import type { BridgeDatabase } from "@bridge/server/database";
import { commands, inputProblem, type CommandName, type CommandSpec } from "@commands/model";
import { resolveCaller } from "@commands/model/callers";
import {
  COMMANDS_PATH,
  commandCallSchema,
  CommandRefusedError,
  type CommandAnswer,
} from "@commands/model/protocol";
import { log } from "@/shared/log";
import { checkOwner } from "./owner";

const ANOTHER_RELEASE =
  "That happens when the CLI runs another release of toy-box-slack, which restarting the bridge fixes.";

/** What a command learns about its call besides its input. */
export type CommandContext = {
  /** The Toy Box channel the caller acts for, or null for a terminal that named none. */
  channelId: string | null;
  /** When the bridge took the call. Commands read the time from here. */
  at: number;
  /** The change the owner confirmed with their passphrase, by the name the bridge gave it. */
  confirmed?: string;
};

export type CommandHandler<Name extends CommandName> = (
  input: z.output<(typeof commands)[Name]["input"]>,
  context: CommandContext,
) => Promise<CommandAnswer>;

export type CommandHandlers = { [Name in CommandName]: CommandHandler<Name> };

/**
 * Serves `handlers`, checking passphrases against the argon2id hash `ownerHash` reads, if any.
 * Calls `onChange` once each command has run, even one that refused or failed, since it may have
 * written first.
 */
export function serveCommands(
  database: BridgeDatabase,
  handlers: CommandHandlers,
  ownerHash: () => string | null,
  onChange: () => void,
  now = Date.now,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const { pathname } = new URL(request.url);
    const name = pathname.slice(COMMANDS_PATH.length);
    if (!pathname.startsWith(COMMANDS_PATH) || !Object.hasOwn(commands, name)) {
      return answerError(404, `The bridge has no command at ${pathname}. ${ANOTHER_RELEASE}`);
    }
    const call = commandCallSchema.safeParse(await request.json().catch(() => undefined));
    if (!call.success) {
      return answerError(
        400,
        `The bridge couldn't read the call to \`${name}\`, so it didn't run. ${ANOTHER_RELEASE}`,
      );
    }

    const spec: CommandSpec = commands[name as CommandName];
    try {
      const links = await database.read(
        (sql) => sql<{ id: string }[]>`SELECT toybox_channel_id AS id FROM links`,
      );
      const linked = new Set(links.map((link) => link.id));
      const resolved = resolveCaller(call.data.caller, linked, name, spec.callers);
      if (resolved.kind === "refused") return answerError(403, resolved.message);
      const input = spec.input.safeParse(call.data.input);
      if (!input.success) {
        return answerError(422, inputProblem(name, spec, call.data.input, input.error));
      }
      const { owner } = call.data;
      if (owner) await checkOwner(owner.passphrase, ownerHash());
      // The schema that parsed the input is the one the handler's type reads.
      const handler = handlers[name as CommandName] as CommandHandler<CommandName>;
      const context = { channelId: resolved.channelId, at: now(), confirmed: owner?.confirms };
      try {
        return Response.json(await handler(input.data as never, context));
      } finally {
        onChange();
      }
    } catch (error) {
      if (error instanceof CommandRefusedError) return answerError(409, error.message);
      log(`Couldn't finish \`${name}\`:`, error);
      return answerError(
        500,
        `The bridge couldn't finish \`${name}\`, so it may or may not have run. Its log says why. Run \`toy-box-slack status\` before you try again.`,
      );
    }
  };
}

function answerError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}
