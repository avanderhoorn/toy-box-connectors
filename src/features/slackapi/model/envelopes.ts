import { z } from "zod";

// Socket Mode frames.
//
// Slack sends JSON frames over the socket: hello once the connection is ready,
// disconnect when it wants a fresh one, and envelopes that carry events or clicks
// and are acked by envelope ID. The receiver reads every frame here before the
// SDK sees it, so a payload the SDK can't dispatch, such as app_rate_limited, is
// still handled, and an envelope whose payload is malformed can still be acked.

const slackIdSchema = z.string().min(1);

const frameHeaderSchema = z
  .object({
    type: z.string().min(1).describe("The frame's type, such as hello or events_api"),
    envelope_id: slackIdSchema.nullish().describe("The delivery's ID, which its ack names"),
  })
  .describe("The fields every Socket Mode frame shares");

const helloSchema = z
  .object({
    connection_info: z
      .object({ app_id: slackIdSchema.nullish().describe("The app the app token belongs to") })
      .nullish()
      .describe("What Slack knows about this connection"),
  })
  .describe("Slack accepted the connection");

const disconnectSchema = z
  .object({ reason: z.string().nullish().describe("Why Slack is closing the connection") })
  .describe("Slack asks the client to reconnect");

const rateLimitedSchema = z
  .object({
    type: z.literal("app_rate_limited"),
    team_id: slackIdSchema.describe("The team whose events were held back"),
    api_app_id: slackIdSchema.describe("The rate-limited app"),
    minute_rate_limited: z
      .number()
      .int()
      .nonnegative()
      .describe("The start of the minute Slack held events back, in epoch seconds"),
  })
  .describe("Slack stopped delivering events for a minute");

const eventCallbackSchema = z
  .object({
    type: z.literal("event_callback"),
    team_id: slackIdSchema.describe("The installation's team, even in a shared channel"),
    api_app_id: slackIdSchema.describe("The app the event is for"),
    event_id: slackIdSchema.describe("The event's ID, the same on every redelivery"),
    event_time: z
      .number()
      .int()
      .nonnegative()
      .describe("When the event happened, in epoch seconds"),
    event: z
      .looseObject({ type: z.string().min(1).describe("The event's type, such as message") })
      .describe("The event itself, which its handler parses"),
  })
  .describe("An Events API event");

const eventsApiPayloadSchema = z.discriminatedUnion("type", [
  eventCallbackSchema,
  rateLimitedSchema,
]);

const envelopeSchema = z
  .object({
    envelope_id: slackIdSchema.describe("The delivery's ID, which its ack names"),
    payload: z.unknown().describe("What the envelope carries"),
  })
  .describe("A delivery Slack wants acked");

/** An event that arrived in an events_api envelope. Its handler parses `event` by its type. */
export type EventCallback = {
  teamId: string;
  appId: string;
  eventId: string;
  /** Epoch seconds. */
  eventTime: number;
  event: { type: string; [key: string]: unknown };
};

/** What a malformed frame still tells the receiver about where a gap could be. */
export type MalformedHint = {
  /** The event's channel when the payload names one. */
  channelId: string | null;
  /** The event's time in epoch seconds when the payload carries one. */
  eventTime: number | null;
};

/** One Socket Mode frame, as much of it as could be read. */
export type SocketFrame =
  | { kind: "hello"; appId: string | null }
  | { kind: "disconnect"; reason: string | null }
  | { kind: "event"; envelopeId: string; callback: EventCallback }
  /** Bare when Slack sent it top-level, with no envelope to ack. */
  | {
      kind: "rate_limited";
      envelopeId: string | null;
      teamId: string;
      appId: string;
      minute: number;
    }
  /** A click or other interaction, which goes to approvals. Its payload isn't an event. */
  | { kind: "interactive"; envelopeId: string; payload: unknown }
  /** A frame type the bridge doesn't use, such as slash_commands. */
  | { kind: "other"; type: string; envelopeId: string | null }
  /** `issues` names zod issue codes and paths only, never content, so it's safe to log. */
  | { kind: "malformed"; envelopeId: string | null; hint: MalformedHint; issues: string[] };

/** Reads one raw Socket Mode frame. Never throws. */
export function readFrame(raw: string): SocketFrame {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return malformed(null, undefined, ["invalid_json"]);
  }
  const header = frameHeaderSchema.safeParse(value);
  if (!header.success) return malformed(null, value, issuesOf(header.error));
  const envelopeId = header.data.envelope_id ?? null;

  switch (header.data.type) {
    case "hello": {
      const hello = helloSchema.safeParse(value);
      return { kind: "hello", appId: hello.data?.connection_info?.app_id ?? null };
    }
    case "disconnect": {
      const disconnect = disconnectSchema.safeParse(value);
      return { kind: "disconnect", reason: disconnect.data?.reason ?? null };
    }
    case "app_rate_limited": {
      const limited = rateLimitedSchema.safeParse(value);
      if (!limited.success) return malformed(envelopeId, value, issuesOf(limited.error));
      return rateLimited(envelopeId, limited.data);
    }
    case "events_api": {
      const envelope = envelopeSchema.safeParse(value);
      if (!envelope.success) return malformed(envelopeId, value, issuesOf(envelope.error));
      const payload = eventsApiPayloadSchema.safeParse(envelope.data.payload);
      if (!payload.success) {
        return malformed(envelopeId, value, issuesOf(payload.error, ["payload"]));
      }
      if (payload.data.type === "app_rate_limited") return rateLimited(envelopeId, payload.data);
      const callback = payload.data;
      return {
        kind: "event",
        envelopeId: envelope.data.envelope_id,
        callback: {
          teamId: callback.team_id,
          appId: callback.api_app_id,
          eventId: callback.event_id,
          eventTime: callback.event_time,
          event: callback.event,
        },
      };
    }
    case "interactive": {
      const envelope = envelopeSchema.safeParse(value);
      if (!envelope.success) return malformed(envelopeId, value, issuesOf(envelope.error));
      return {
        kind: "interactive",
        envelopeId: envelope.data.envelope_id,
        payload: envelope.data.payload,
      };
    }
    default:
      return { kind: "other", type: header.data.type, envelopeId };
  }
}

/** Describes a zod error by issue codes and paths only, so it never repeats content. */
export function issuesOf(error: z.ZodError, prefix: PropertyKey[] = []): string[] {
  return error.issues.map((issue) => {
    const path = [...prefix, ...issue.path].map(String).join(".");
    return path ? `${issue.code} at ${path}` : issue.code;
  });
}

function rateLimited(
  envelopeId: string | null,
  payload: z.output<typeof rateLimitedSchema>,
): SocketFrame {
  return {
    kind: "rate_limited",
    envelopeId,
    teamId: payload.team_id,
    appId: payload.api_app_id,
    minute: payload.minute_rate_limited,
  };
}

function malformed(envelopeId: string | null, value: unknown, issues: string[]): SocketFrame {
  return { kind: "malformed", envelopeId, hint: hintOf(value), issues };
}

const hintSchema = z.object({
  payload: z
    .object({
      event_time: z.number().int().nonnegative().optional().catch(undefined),
      event: z.object({ channel: slackIdSchema.optional() }).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

function hintOf(value: unknown): MalformedHint {
  const hint = hintSchema.safeParse(value);
  return {
    channelId: hint.data?.payload?.event?.channel ?? null,
    eventTime: hint.data?.payload?.event_time ?? null,
  };
}
