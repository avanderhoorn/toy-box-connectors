import { z } from "zod";

const id = z.string().min(1);
const authorizationSchema = z.object({
  enterprise_id: id.nullish().describe("Installation org"),
  team_id: id.nullish().describe("Installation workspace"),
  user_id: id.nullish().describe("Installation bot user"),
  is_bot: z.boolean().nullish().describe("Bot authorization"),
  is_enterprise_install: z.boolean().nullish().describe("Org-wide authorization"),
});
const callbackSchema = z.object({
  type: z.literal("event_callback"),
  team_id: id.describe("Event workspace, not necessarily the installation's"),
  api_app_id: id.describe("Receiving app"),
  authorizations: z.array(authorizationSchema).nullish().describe("Receiving installation"),
  event: z.looseObject({ type: id.describe("Event type") }),
});
const rateLimitSchema = z.object({ type: z.literal("app_rate_limited") });
const payloadSchema = z.discriminatedUnion("type", [callbackSchema, rateLimitSchema]);
const headerSchema = z.object({
  type: id.describe("Socket frame type"),
  envelope_id: id.nullish().describe("Acknowledgement identity"),
  payload: z.unknown().optional().describe("Event payload"),
  connection_info: z.unknown().optional(),
  reason: z.unknown().optional(),
});
export type Authorization = {
  enterpriseId: string | null;
  teamId: string | null;
  userId: string | null;
  isBot: boolean;
  isEnterpriseInstall: boolean;
};
export type EventCallback = {
  teamId: string;
  appId: string;
  authorizations: Authorization[] | null;
  event: { type: string; [key: string]: unknown };
};
export type SocketFrame =
  | { kind: "hello"; appId: string | null }
  | { kind: "disconnect"; reason: string | null }
  | { kind: "event"; envelopeId: string; callback: EventCallback }
  | { kind: "rate_limited"; envelopeId: string | null }
  | { kind: "other"; envelopeId: string | null }
  | { kind: "malformed"; envelopeId: string | null; issues: string[] };

/** Raw frames bypass SDK dispatch, which cannot handle Slack's top-level app_rate_limited. */
export function readFrame(raw: string): SocketFrame {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return malformed(null, ["invalid_json"]);
  }
  const parsed = headerSchema.safeParse(value);
  if (!parsed.success) return malformed(null, issuesOf(parsed.error));
  const header = parsed.data;
  const envelopeId = header.envelope_id ?? null;
  if (header.type === "hello") {
    const info = z.object({ app_id: id.nullish() }).nullish().safeParse(header.connection_info);
    return info.success
      ? { kind: "hello", appId: info.data?.app_id ?? null }
      : malformed(envelopeId, issuesOf(info.error));
  }
  if (header.type === "disconnect") {
    const reason = z.string().nullish().safeParse(header.reason);
    return reason.success
      ? { kind: "disconnect", reason: reason.data ?? null }
      : malformed(envelopeId, issuesOf(reason.error));
  }
  if (!["events_api", "app_rate_limited"].includes(header.type))
    return { kind: "other", envelopeId };
  const payload = payloadSchema.safeParse(
    header.type === "app_rate_limited" ? value : header.payload,
  );
  if (!payload.success) return malformed(envelopeId, issuesOf(payload.error));
  const event = payload.data;
  if (event.type === "app_rate_limited") return { kind: "rate_limited", envelopeId };
  if (!envelopeId) return malformed(null, ["missing_envelope_id"]);
  return {
    kind: "event",
    envelopeId,
    callback: {
      teamId: event.team_id,
      appId: event.api_app_id,
      event: event.event,
      // An absent list permits the documented team fallback. An empty list never does.
      authorizations:
        event.authorizations?.map((entry) => ({
          enterpriseId: entry.enterprise_id ?? null,
          teamId: entry.team_id ?? null,
          userId: entry.user_id ?? null,
          isBot: entry.is_bot ?? false,
          isEnterpriseInstall: entry.is_enterprise_install ?? false,
        })) ?? null,
    },
  };
}

export function issuesOf(error: z.ZodError, prefix: PropertyKey[] = []): string[] {
  return error.issues.map(
    (issue) => `${issue.code} at ${[...prefix, ...issue.path].map(String).join(".")}`,
  );
}

function malformed(envelopeId: string | null, issues: string[]): SocketFrame {
  return { kind: "malformed", envelopeId, issues };
}
