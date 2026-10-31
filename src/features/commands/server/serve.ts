// The bridge works out who's calling before anything else, so a caller it won't act for learns
// nothing about any channel. Then it parses the input with the command's schema, finds the app the
// command runs in (see ../model/routing), and runs it there.
//
// A Toy Box channel links through at most one app. Link and resume are the only commands that make
// a link, so they run one at a time across every app, each finding the app it runs in once those
// before it are done.

import type { z } from "zod";
import {
  commands,
  inputProblem,
  optionName,
  type CommandName,
  type CommandSpec,
} from "@commands/model";
import { resolveCaller } from "@commands/model/callers";
import {
  COMMANDS_PATH,
  commandCallSchema,
  CommandRefusedError,
  type CommandAnswer,
  type CommandCall,
} from "@commands/model/protocol";
import { routeCommand } from "@commands/model/routing";
import { log, type Log } from "@/shared/log";
import { SerialTaskQueue } from "@/shared/serialTaskQueue";
import type { StatusCommand, StatusSource } from "./status";

const ANOTHER_RELEASE =
  "That happens when the CLI runs another release of toy-box-slack, which restarting the bridge fixes.";

/**
 * Says an option the command doesn't take came from another release, or null when no option was
 * unknown. A renamed option also shows up as a missing one, so it names only the unknown.
 */
function unknownOptions(name: string, error: z.ZodError): string | null {
  const unknown = error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys" ? issue.keys.map((key) => `--${optionName(key)}`) : [],
  );
  if (unknown.length === 0) return null;
  const shown = new Intl.ListFormat("en", { type: "disjunction" }).format(unknown);
  return `The bridge's \`${name}\` doesn't take ${shown}, so it didn't run. ${ANOTHER_RELEASE}`;
}

const LINKING = new Set<CommandName>(["link", "resume"]);

/** What a command learns about its call besides its input. */
export type CommandContext = {
  /** The Toy Box channel the caller acts for, or null for a terminal that named none. */
  channelId: string | null;
  /** When the bridge took the call. Commands read the time from here. */
  at: number;
};

export type CommandHandler<Name extends CommandName> = (
  input: z.output<(typeof commands)[Name]["input"]>,
  context: CommandContext,
) => Promise<CommandAnswer>;

/** The commands that run in one app. Status runs across them (see ./status). */
export type AppCommandHandlers = {
  [Name in Exclude<CommandName, "status">]: CommandHandler<Name>;
};

/** One app the bridge hosts, as its commands reach it. */
export type ServedApp = StatusSource & {
  handlers: AppCommandHandlers;
  /** Where the app's lines in the bridge's log go. */
  log: Log;
  /** Called once a command ran in the app, since it may have changed a link or request. */
  onChange(): void;
};

export type ServeCommandsOptions = {
  /** The apps the bridge hosts, the default app first. */
  apps: readonly ServedApp[];
  status: StatusCommand;
  now?: () => number;
};

/**
 * Serves the commands of `apps`. Calls an app's `onChange` once a command ran in it, even one that
 * refused or failed, since it may have written first.
 */
export function serveCommands({
  apps,
  status,
  now = Date.now,
}: ServeCommandsOptions): (request: Request) => Promise<Response> {
  const linking = new SerialTaskQueue();
  const hosted = apps.map((app) => app.name);

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
    const serve = () => serveCall(name as CommandName, call.data);
    return LINKING.has(name as CommandName) ? linking.enqueue(serve) : serve();
  };

  async function serveCall(name: CommandName, call: CommandCall): Promise<Response> {
    const spec: CommandSpec = commands[name];
    let ran: readonly ServedApp[] = [];
    try {
      const linkedThrough = await readLinkedThrough(apps);
      const resolved = resolveCaller(
        call.caller,
        new Set(linkedThrough.keys()),
        name,
        spec.callers,
      );
      if (resolved.kind === "refused") return answerError(403, resolved.message);
      const input = spec.input.safeParse(call.input);
      if (!input.success) {
        return answerError(
          422,
          unknownOptions(name, input.error) ?? inputProblem(name, spec, call.input, input.error),
        );
      }
      const { channelId } = resolved;
      const route = routeCommand({
        name,
        channelId,
        app: typeof input.data.app === "string" ? input.data.app : undefined,
        linkedThrough: channelId === null ? null : (linkedThrough.get(channelId) ?? null),
        hosted,
      });
      if (route.kind === "refused") return answerError(409, route.message);
      const context = { channelId, at: now() };
      ran = route.kind === "every" ? apps : apps.filter((app) => app.name === route.app);
      try {
        if (name === "status") return Response.json(await status(ran, context));
        // The schema that parsed the input is the one the handler's type reads.
        const handler = ran[0]!.handlers[name] as CommandHandler<typeof name>;
        return Response.json(await handler(input.data as never, context));
      } finally {
        for (const app of ran) app.onChange();
      }
    } catch (error) {
      if (error instanceof CommandRefusedError) return answerError(409, error.message);
      (ran.length === 1 ? ran[0]!.log : log)(`Couldn't finish \`${name}\`:`, error);
      return answerError(
        500,
        `The bridge couldn't finish \`${name}\`, so it may or may not have run. Its log says why. Run \`toy-box-slack status\` before you try again.`,
      );
    }
  }
}

/** The app each linked Toy Box channel links through, by the channel's ID. */
async function readLinkedThrough(apps: readonly ServedApp[]): Promise<Map<string, string>> {
  const linkedThrough = new Map<string, string>();
  for (const app of apps) {
    const links = await app.database.read(
      (sql) => sql<{ id: string }[]>`SELECT toybox_channel_id AS id FROM links`,
    );
    for (const { id } of links) if (!linkedThrough.has(id)) linkedThrough.set(id, app.name);
  }
  return linkedThrough;
}

function answerError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}
