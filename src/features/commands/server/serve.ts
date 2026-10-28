// Answering calls on the bridge's socket.
//
// Each call is one POST to a command's path, carrying what the caller's environment says about it
// and the values the CLI read. The bridge works out who's calling before anything else, so a caller
// it won't act for learns nothing about any channel. Then it checks the values against the
// command's contract and runs the handler. The banner is read last, so an answer shows what its
// command changed.

import type { BridgeDatabase } from "@bridge/server/database";
import type { SlackConnection } from "@commands/model/banner";
import {
  permitCaller,
  resolveCaller,
  type Caller,
  type CallerFacts,
  type CallerResolution,
} from "@commands/model/callers";
import { checkCommandInput } from "@commands/model/commandLine";
import {
  CommandRefusedError,
  type CommandCall,
  type CommandContract,
  type CommandHandler,
  type CommandHandlersFor,
} from "@commands/model/contract";
import {
  commandAt,
  commandRequestSchema,
  PROTOCOL_VERSION,
  type CommandRefusal,
  type Refusal,
} from "@commands/model/protocol";
import type { SlackState } from "@commands/model/status";
import type { ToyBoxClient } from "@toybox/server";
import { readBanner } from "./banner";

export type CommandServerOptions<Contracts extends Record<string, CommandContract>> = {
  /** Every command the bridge serves, and the handler that runs each. */
  contracts: Contracts;
  handlers: CommandHandlersFor<Contracts>;
  database: BridgeDatabase;
  /** The Toy Box the bridge serves. A caller running in another is refused. */
  origin: URL;
  toyBox: Pick<ToyBoxClient, "catalog" | "loadCatalog">;
  slack: () => SlackState;
  now?: () => number;
};

// Without these, the bridge can't receive from Slack or post to it.
const unusableSlack: ReadonlySet<SlackConnection> = new Set([
  "unconfigured",
  "auth_failed",
  "refused",
]);

/** Answers each request on the bridge's socket. */
export function serveCommands<Contracts extends Record<string, CommandContract>>({
  contracts,
  handlers,
  database,
  origin,
  toyBox,
  slack,
  now = Date.now,
}: CommandServerOptions<Contracts>): (request: Request) => Promise<Response> {
  // A session missing from the catalog may have joined since the bridge read it.
  async function identify(facts: CallerFacts): Promise<CallerResolution> {
    const known = resolveCaller(facts, { origin, catalog: toyBox.catalog() });
    if (known.kind === "caller" || known.rule !== "unknown_session") return known;
    try {
      return resolveCaller(facts, { origin, catalog: await toyBox.loadCatalog() });
    } catch (error) {
      console.error("Couldn't read Toy Box's channels to tell who's calling:", error);
      return {
        kind: "refused",
        rule: "toy_box_unreachable",
        message: `The bridge couldn't reach the Toy Box at ${origin.origin} to tell who you are. Check that Toy Box is running, then try again.`,
      };
    }
  }

  return async (request) => {
    const path = new URL(request.url).pathname;
    const name = commandAt(path);
    if (name === null || !Object.hasOwn(contracts, name)) {
      return Response.json({ error: `The bridge has no command at ${path}.` }, { status: 404 });
    }
    if (request.method !== "POST") {
      return Response.json(
        { error: `Commands take POST, not ${request.method}.` },
        { status: 405, headers: { Allow: "POST" } },
      );
    }
    const call = commandRequestSchema.safeParse(await request.json().catch(() => undefined));
    if (!call.success) {
      return Response.json(
        {
          error: `The bridge couldn't read the call to \`${name}\`, so it didn't run. That happens when the CLI runs another release of toy-box-slack. Whoever runs the bridge can restart it to run the same release as the CLI.`,
        },
        { status: 400 },
      );
    }

    const at = now();
    const contract: CommandContract = contracts[name]!;
    const identified = await identify(call.data.caller);
    const permitted =
      identified.kind === "caller"
        ? permitCaller(identified.caller, { name, ...contract })
        : identified;
    if (permitted.kind === "refused") {
      return refuse(permitted.rule === "toy_box_unreachable" ? 503 : 403, at, null, permitted);
    }
    const { caller } = permitted;

    try {
      const state = slack();
      const banner = () =>
        database.read((sql) => readBanner(sql, caller, { slack: slack().connection, at }));
      if (!contract.withoutSlack && unusableSlack.has(state.connection)) {
        const message = [
          `\`${name}\` needs Slack, which the bridge can't use right now.`,
          state.problem,
          "Until then it runs only `status` and `doctor`.",
        ];
        return refuse(503, at, await banner(), {
          rule: "slack_unavailable",
          message: message.filter(Boolean).join(" "),
        });
      }

      const checked = checkCommandInput(name, contract, call.data.input);
      if (checked.kind === "refused") {
        return refuse(422, at, await banner(), { rule: "invalid_input", message: checked.message });
      }
      try {
        const result = contract.result.parse(
          await runHandler(handlers[name], checked.input, { caller, at }),
        );
        return Response.json({ version: PROTOCOL_VERSION, at, banner: await banner(), result });
      } catch (error) {
        if (!(error instanceof CommandRefusedError)) throw error;
        return refuse(409, at, await banner(), { rule: error.rule, message: error.message });
      }
    } catch (error) {
      console.error(`Couldn't finish \`${name}\`:`, error);
      return Response.json(
        {
          error: `The bridge couldn't finish \`${name}\`, so it may or may not have run. Its log says why. Check \`toy-box-slack status\` before you run \`${name}\` again.`,
        },
        { status: 500 },
      );
    }
  };
}

// The contract parsed the input, and permitCaller gave a channel command a caller with a channel.
function runHandler(handler: unknown, input: unknown, call: { caller: Caller; at: number }) {
  return (handler as CommandHandler<CommandContract>)(input as never, call as CommandCall);
}

function refuse(
  status: number,
  at: number,
  banner: CommandRefusal["banner"],
  { rule, message }: Refusal,
): Response {
  const refusal: CommandRefusal = {
    version: PROTOCOL_VERSION,
    at,
    banner,
    refused: { rule, message },
  };
  return Response.json(refusal, { status });
}
