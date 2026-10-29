// Copilot sets COPILOT_AGENT_SESSION_ID to the Toy Box session it runs, and a lead's session ID is
// its channel's ID. A caller with no session is someone at a terminal, and every other session, such
// as a channel member's, is refused. Any local process can set or unset the variable, so roles stop
// mistakes rather than attacks. Refusals never say how to become someone else, because an agent
// told which variable to unset would unset it.

import { z } from "zod";

// Toy Box's durable IDs, as in toy-box's src/features/channels/model/index.ts.
const toyBoxIdSchema = z.string().trim().min(1).max(255);

/** COPILOT_AGENT_SESSION_ID and the channel --channel names, as the CLI read them. */
export const callerFactsSchema = z
  .object({ sessionId: toyBoxIdSchema.nullable(), channelId: toyBoxIdSchema.nullable() })
  .strict();
export type CallerFacts = z.output<typeof callerFactsSchema>;

/** The session COPILOT_AGENT_SESSION_ID names in `env`, or null for someone at a terminal. */
export function resolveSessionId(env: NodeJS.ProcessEnv): string | null {
  return env.COPILOT_AGENT_SESSION_ID?.trim() || null;
}

export type CallerRole = "lead" | "terminal";

const runners: Record<CallerRole, string> = {
  lead: "the lead of a linked Toy Box channel",
  terminal: "the owner at a terminal",
};

/**
 * The Toy Box channel the bridge acts for, or why it won't. A terminal acts for the channel
 * --channel names, or for none.
 */
export type CallerResolution =
  | { kind: "caller"; channelId: string | null }
  | { kind: "refused"; message: string };

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
  return { kind: "caller", channelId: sessionId ?? channelId };
}
