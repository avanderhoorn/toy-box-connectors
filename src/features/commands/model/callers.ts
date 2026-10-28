// Who is calling the bridge.
//
// The CLI forwards what its environment says about whoever runs it, and the bridge decides from
// Toy Box's catalog. Copilot sets COPILOT_AGENT_SESSION_ID to the Toy Box session, which for a
// lead is its channel's ID, and Toy Box gives every agent it runs NITRO_PORT. A caller without a
// session is the operator at a terminal. Any local process can set or unset those variables, so
// roles stop mistakes rather than attacks.
//
// Refusals say who may run a command and never how to become someone else, because an agent
// told which variable to unset would unset it.

import { z } from "zod";
import type { ToyBoxCatalog } from "@toybox/model";

export const callerRoles = ["lead", "member", "operator"] as const;
export type CallerRole = (typeof callerRoles)[number];

/**
 * Whether a command acts for one Toy Box channel, which the operator names with --channel, or
 * for the whole bridge.
 */
export type CommandScope = "channel" | "bridge";

// Toy Box's durable IDs, as in the toy-box repo's src/features/channels/model/index.ts.
const toyBoxIdSchema = z.string().trim().min(1).max(255);

/** What the CLI forwards about who is running it. */
export const callerFactsSchema = z
  .object({
    sessionId: toyBoxIdSchema
      .nullable()
      .describe(
        "COPILOT_AGENT_SESSION_ID, the calling agent's Toy Box session, or null outside one",
      ),
    toyBoxPort: z
      .number()
      .int()
      .min(1)
      .max(65_535)
      .nullable()
      .describe("NITRO_PORT, the port of the Toy Box the caller runs in, or null when it's unset"),
    channelId: toyBoxIdSchema.nullable().describe("The Toy Box channel --channel names, or null"),
  })
  .strict();
export type CallerFacts = z.output<typeof callerFactsSchema>;

/**
 * What `env` says about whoever runs the CLI, with the channel --channel named. A variable that's
 * empty or isn't a port says nothing.
 */
export function readCallerFacts(
  env: Record<string, string | undefined>,
  channelId: string | null,
): CallerFacts {
  const port = env.NITRO_PORT?.trim() ?? "";
  return {
    sessionId: env.COPILOT_AGENT_SESSION_ID?.trim() || null,
    toyBoxPort:
      /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65_535 ? Number(port) : null,
    channelId,
  };
}

/**
 * Who the bridge acts for. A lead or member always acts for its own channel, and the operator
 * for the channel it names, if any.
 */
export type Caller =
  | { role: "lead" | "member"; channelId: string; sessionId: string }
  | { role: "operator"; channelId: string | null; sessionId: null };

/** A caller acting for one Toy Box channel. */
export type ChannelCaller = Caller & { channelId: string };

/** The rule that refused a caller. */
export type CallerRule =
  | "toy_box_port"
  | "toy_box_unreachable"
  | "unknown_session"
  | "channel_mismatch"
  | "role"
  | "channel_required";

export type CallerResolution<Resolved extends Caller = Caller> =
  | { kind: "caller"; caller: Resolved }
  | { kind: "refused"; rule: CallerRule; message: string };

/**
 * Who is calling, by the bridge's Toy Box and its catalog, or the rule that refuses the call. A
 * catalog the bridge hasn't read lists no one, and the bridge reads it again once before it
 * believes a session is unknown.
 */
export function resolveCaller(
  facts: CallerFacts,
  toyBox: { origin: URL; catalog: ToyBoxCatalog | null },
): CallerResolution {
  const { origin, catalog } = toyBox;
  if (facts.toyBoxPort !== null && facts.toyBoxPort !== toyBoxPort(origin)) {
    return refused(
      "toy_box_port",
      `You're running in the Toy Box on port ${facts.toyBoxPort}, but this bridge serves the one at ${origin.origin}, so it won't act for you.`,
    );
  }

  if (facts.sessionId === null) {
    return {
      kind: "caller",
      caller: { role: "operator", channelId: facts.channelId, sessionId: null },
    };
  }

  const session = catalog && findSession(catalog, facts.sessionId);
  if (!session) {
    return refused(
      "unknown_session",
      `Session ${facts.sessionId} isn't the lead or a member of a channel in the Toy Box at ${origin.origin}, so the bridge won't act for it.`,
    );
  }
  if (facts.channelId !== null && facts.channelId !== session.channelId) {
    const yours =
      session.role === "lead"
        ? `You lead channel ${session.channelId}`
        : `You're a member of channel ${session.channelId}`;
    return refused(
      "channel_mismatch",
      `${yours}, but --channel names ${facts.channelId}. Leave out --channel to act for your own channel.`,
    );
  }
  return { kind: "caller", caller: { ...session, sessionId: facts.sessionId } };
}

/**
 * Lets `caller` run `command` when its role may, and when the command acts for one channel, only
 * once the caller has one. Otherwise says who may run it.
 */
export function permitCaller(
  caller: Caller,
  command: { name: string; roles: readonly CallerRole[]; scope: CommandScope },
): CallerResolution {
  if (!command.roles.includes(caller.role)) {
    const who = command.roles.map((role) => roleNames[role]).join(" or ");
    return refused("role", `Only ${who} can run \`${command.name}\`. ${roleLimits[caller.role]}`);
  }
  if (command.scope === "channel" && caller.channelId === null) {
    return refused(
      "channel_required",
      `\`${command.name}\` acts for one Toy Box channel. Pass --channel with its ID, because from a terminal the bridge can't tell which channel you mean.`,
    );
  }
  return { kind: "caller", caller };
}

const roleNames: Record<CallerRole, string> = {
  lead: "the channel's lead",
  member: "a member",
  operator: "the operator",
};

const roleLimits: Record<CallerRole, string> = {
  lead: "Ask whoever runs the bridge to run it from a terminal outside Toy Box.",
  member: "A member may only read.",
  operator: "The operator may read and run setup, but never reply or publish.",
};

function findSession(
  catalog: ToyBoxCatalog,
  sessionId: string,
): { role: "lead" | "member"; channelId: string } | undefined {
  if (catalog.channels.some((channel) => channel.id === sessionId)) {
    return { role: "lead", channelId: sessionId };
  }
  const member = catalog.members.find((candidate) => candidate.id === sessionId);
  return member && { role: "member", channelId: member.channelId };
}

// The bridge's Toy Box is http on loopback, so a URL without a port means 80.
function toyBoxPort(origin: URL): number {
  return Number(origin.port || 80);
}

function refused(rule: CallerRule, message: string): CallerResolution {
  return { kind: "refused", rule, message };
}
