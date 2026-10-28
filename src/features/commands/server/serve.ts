// Answering calls on the bridge's socket.
//
// Each call is one POST to a command's path. The bridge works out who's calling before anything
// else, so a caller it won't act for learns nothing about any channel. Then it parses the values
// with the command's input schema and runs the command.

import type { z } from "zod";
import type { BridgeDatabase } from "@bridge/server/database";
import { commands, inputProblem, type CommandName, type CommandSpec } from "@commands/model";
import { resolveCaller, type Caller } from "@commands/model/callers";
import {
  commandAt,
  commandCallSchema,
  CommandRefusedError,
  type CommandAnswer,
} from "@commands/model/protocol";

const ANOTHER_RELEASE =
  "That happens when the CLI runs another release of toy-box-slack, which restarting the bridge fixes.";

/** What a command learns about its call besides its input. */
export type CommandContext = {
  caller: Caller;
  /** When the bridge took the call. Commands read the time from here. */
  at: number;
};

/** Runs one command with the input its schema parsed. */
export type CommandHandler<Name extends CommandName> = (
  input: z.output<(typeof commands)[Name]["input"]>,
  context: CommandContext,
) => Promise<CommandAnswer>;

export type CommandHandlers = { [Name in CommandName]: CommandHandler<Name> };

/** Answers each request on the bridge's socket. */
export function serveCommands(
  database: BridgeDatabase,
  handlers: CommandHandlers,
  now = Date.now,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const { pathname } = new URL(request.url);
    const name = commandAt(pathname);
    if (name === null || !Object.hasOwn(commands, name)) {
      return Response.json(
        { error: `The bridge has no command at ${pathname}. ${ANOTHER_RELEASE}` },
        { status: 404 },
      );
    }
    const call = commandCallSchema.safeParse(await request.json().catch(() => undefined));
    if (!call.success) {
      return Response.json(
        {
          error: `The bridge couldn't read the call to \`${name}\`, so it didn't run. ${ANOTHER_RELEASE}`,
        },
        { status: 400 },
      );
    }

    const spec: CommandSpec = commands[name as CommandName];
    try {
      const linked = await database.read(readLinkedChannels);
      const resolved = resolveCaller(call.data.caller, linked, name, spec.callers);
      if (resolved.kind === "refused") {
        return Response.json({ error: resolved.message }, { status: 403 });
      }
      const input = spec.input.safeParse(call.data.input);
      if (!input.success) {
        const error = inputProblem(name, spec, call.data.input, input.error);
        return Response.json({ error }, { status: 422 });
      }
      // The schema that parsed the input is the one the handler's type reads.
      const handler = handlers[name as CommandName] as CommandHandler<CommandName>;
      return Response.json(
        await handler(input.data as never, { caller: resolved.caller, at: now() }),
      );
    } catch (error) {
      if (error instanceof CommandRefusedError) {
        return Response.json({ error: error.message }, { status: 409 });
      }
      console.error(`Couldn't finish \`${name}\`:`, error);
      return Response.json(
        {
          error: `The bridge couldn't finish \`${name}\`, so it may or may not have run. Its log says why. Run \`toy-box-slack status\` before you try again.`,
        },
        { status: 500 },
      );
    }
  };
}

async function readLinkedChannels(sql: Bun.SQL): Promise<Set<string>> {
  const links = await sql<{ channelId: string }[]>`
    SELECT toybox_channel_id AS channelId FROM links
  `;
  return new Set(links.map((link) => link.channelId));
}
