import { describe, expect, test } from "bun:test";
import { readFrame } from "./envelopes";

const callback = {
  type: "event_callback",
  team_id: "THOME",
  api_app_id: "AAPP",
  event_id: "Ev1",
  event_time: 1700000000,
  event: { type: "message", channel: "C1", user: "UALICE", text: "hi", ts: "1700000000.000100" },
};

function frame(value: unknown): string {
  return JSON.stringify(value);
}

describe("reading Socket Mode frames", () => {
  test("hello names the app the token belongs to", () => {
    expect(
      readFrame(frame({ type: "hello", num_connections: 1, connection_info: { app_id: "AAPP" } })),
    ).toEqual({ kind: "hello", appId: "AAPP" });
    expect(readFrame(frame({ type: "hello" }))).toEqual({ kind: "hello", appId: null });
  });

  test("disconnect carries its reason", () => {
    expect(readFrame(frame({ type: "disconnect", reason: "refresh_requested" }))).toEqual({
      kind: "disconnect",
      reason: "refresh_requested",
    });
    expect(readFrame(frame({ type: "disconnect" }))).toEqual({ kind: "disconnect", reason: null });
  });

  test("an events_api envelope carries its event for the handler to parse", () => {
    const read = readFrame(
      frame({
        type: "events_api",
        envelope_id: "env-1",
        accepts_response_payload: false,
        retry_attempt: 1,
        retry_reason: "timeout",
        payload: { ...callback, authorizations: [{ team_id: "THOME" }] },
      }),
    );
    expect(read).toEqual({
      kind: "event",
      envelopeId: "env-1",
      callback: {
        teamId: "THOME",
        appId: "AAPP",
        eventId: "Ev1",
        eventTime: 1700000000,
        event: callback.event,
      },
    });
  });

  test("app_rate_limited is read whether Slack wraps it in an envelope or not", () => {
    const limited = {
      type: "app_rate_limited",
      token: "ignored",
      team_id: "THOME",
      minute_rate_limited: 1700000040,
      api_app_id: "AAPP",
    };
    expect(
      readFrame(frame({ type: "events_api", envelope_id: "env-2", payload: limited })),
    ).toEqual({
      kind: "rate_limited",
      envelopeId: "env-2",
      teamId: "THOME",
      appId: "AAPP",
      minute: 1700000040,
    });
    expect(readFrame(frame(limited))).toEqual({
      kind: "rate_limited",
      envelopeId: null,
      teamId: "THOME",
      appId: "AAPP",
      minute: 1700000040,
    });
  });

  test("an interactive envelope keeps its payload for approvals and has no event", () => {
    const payload = { type: "block_actions", user: { id: "UOWNER" }, actions: [] };
    expect(
      readFrame(
        frame({
          type: "interactive",
          envelope_id: "env-3",
          payload,
          accepts_response_payload: true,
        }),
      ),
    ).toEqual({ kind: "interactive", envelopeId: "env-3", payload });
  });

  test("a frame type the bridge doesn't use is passed on with its envelope ID", () => {
    expect(readFrame(frame({ type: "slash_commands", envelope_id: "env-4", payload: {} }))).toEqual(
      {
        kind: "other",
        type: "slash_commands",
        envelopeId: "env-4",
      },
    );
  });
});

describe("malformed frames", () => {
  test("an unreadable frame has nothing to ack", () => {
    expect(readFrame("{not json")).toEqual({
      kind: "malformed",
      envelopeId: null,
      hint: { channelId: null, eventTime: null },
      issues: ["invalid_json"],
    });
    expect(readFrame(frame(["hello"]))).toMatchObject({ kind: "malformed", envelopeId: null });
  });

  test("an envelope whose payload is malformed keeps its ID so it can be acked", () => {
    const read = readFrame(
      frame({
        type: "events_api",
        envelope_id: "env-5",
        payload: { ...callback, event_id: undefined, event: { ...callback.event, type: 7 } },
      }),
    );
    expect(read).toEqual({
      kind: "malformed",
      envelopeId: "env-5",
      hint: { channelId: "C1", eventTime: 1700000000 },
      issues: ["invalid_type at payload.event_id", "invalid_type at payload.event.type"],
    });
  });

  test("a payload that's neither an event nor a rate limit is malformed", () => {
    const read = readFrame(
      frame({ type: "events_api", envelope_id: "env-6", payload: { type: "url_verification" } }),
    );
    expect(read).toMatchObject({ kind: "malformed", envelopeId: "env-6" });
    expect(readFrame(frame({ type: "events_api", envelope_id: "env-7" }))).toMatchObject({
      kind: "malformed",
      envelopeId: "env-7",
    });
    expect(readFrame(frame({ type: "interactive" }))).toMatchObject({
      kind: "malformed",
      envelopeId: null,
    });
  });

  test("a malformed rate limit is still malformed, not a minute to repair", () => {
    expect(
      readFrame(
        frame({
          type: "app_rate_limited",
          team_id: "THOME",
          api_app_id: "AAPP",
          minute_rate_limited: "soon",
        }),
      ),
    ).toMatchObject({ kind: "malformed", envelopeId: null });
  });

  test("diagnostics name issue codes and paths but never the payload's content", () => {
    const secret = "the launch code is 4829-1734";
    const read = readFrame(
      frame({
        type: "events_api",
        envelope_id: "env-8",
        payload: { ...callback, team_id: secret, event: secret },
      }),
    );
    expect(read.kind).toBe("malformed");
    expect(JSON.stringify(read)).not.toContain("4829");
    expect(read).toMatchObject({ hint: { channelId: null, eventTime: 1700000000 } });
  });

  test("a hint keeps what it can read and ignores a channel or time that isn't one", () => {
    const hint = (payload: unknown) =>
      readFrame(frame({ type: "events_api", envelope_id: "env-9", payload }));
    expect(hint({ event_time: "now", event: { channel: "C1" } })).toMatchObject({
      hint: { channelId: "C1", eventTime: null },
    });
    expect(hint({ event_time: 1700000000, event: { channel: 42 } })).toMatchObject({
      hint: { channelId: null, eventTime: 1700000000 },
    });
  });
});
