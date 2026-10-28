// Who is calling the bridge.
//
// Copilot sets COPILOT_AGENT_SESSION_ID to the Toy Box session it runs, which for a lead is its
// channel's ID, so a session that's a linked channel's ID is that channel's lead. A caller with no
// session is someone at a terminal, who names the channel with --channel. Every other session, such
// as a channel member's, is refused. Any local process can set or unset the variable, so roles stop
// mistakes rather than attacks, and the passphrase is what stops widening.
//
// Refusals say who may run a command and never how to become someone else, because an agent told
// which variable to unset would unset it.

import { z } from "zod";

// Toy Box's durable IDs, as in toy-box's src/features/channels/model/index.ts.
const toyBoxIdSchema = z.string().trim().min(1).max(255);

/** What the CLI forwards about whoever runs it. */
export const callerFactsSchema = z
  .object({
    sessionId: toyBoxIdSchema
      .nullable()
      .describe("COPILOT_AGENT_SESSION_ID, or null outside a Copilot session"),
    channelId: toyBoxIdSchema.nullable().describe("The Toy Box channel --channel names, or null"),
  })
  .strict();
export type CallerFacts = z.output<typeof callerFactsSchema>;

export type CallerRole = "lead" | "terminal";

const runners: Record<CallerRole, string> = {
  lead: "the lead of a linked Toy Box channel",
  terminal: "the owner at a terminal",
};

/** Who the bridge acts for. A terminal acts for the channel --channel names, or for none. */
export type Caller = { role: CallerRole; channelId: string | null };

export type CallerResolution =
  | { kind: "caller"; caller: Caller }
  | { kind: "refused"; message: string };

/** What `env` says about whoever runs the CLI, with the channel --channel named. */
export function readCallerFacts(
  env: Record<string, string | undefined>,
  channelId: string | null,
): CallerFacts {
  return { sessionId: env.COPILOT_AGENT_SESSION_ID?.trim() || null, channelId };
}

/** Who `facts` describe, when `linked` holds every linked Toy Box channel, if they may run `name`. */
export function resolveCaller(
  facts: CallerFacts,
  linked: ReadonlySet<string>,
  name: string,
  callers: readonly CallerRole[],
): CallerResolution {
  const { sessionId, channelId } = facts;
  if (sessionId !== null && !linked.has(sessionId)) {
    return {
      kind: "refused",
      message:
        "This session isn't the lead of a Toy Box channel linked to Slack, so it can't use toy-box-slack. If you lead a channel whose link was removed, delete its routines that run toy-box-slack.",
    };
  }
  if (sessionId !== null && channelId !== null && channelId !== sessionId) {
    return {
      kind: "refused",
      message: "A lead acts only for its own Toy Box channel. Run it again without --channel.",
    };
  }
  const role = sessionId === null ? "terminal" : "lead";
  if (!callers.includes(role)) {
    const allowed = callers.map((runner) => runners[runner]).join(" or ");
    return { kind: "refused", message: `Only ${allowed} runs \`${name}\`.` };
  }
  return { kind: "caller", caller: { role, channelId: sessionId ?? channelId } };
}
