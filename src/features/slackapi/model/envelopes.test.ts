import { expect, test } from "bun:test";
import { readFrame } from "./envelopes";

const callback = {
  type: "event_callback",
  team_id: "T1",
  api_app_id: "A1",
  event_id: "Ev1",
  event_time: 1,
  event: { type: "message", channel: "C1", text: "private content" },
};
const frame = (payload: unknown) =>
  JSON.stringify({ type: "events_api", envelope_id: "env1", payload });

test("raw Socket Mode accepts bare and enveloped rate limits, retaining ack identity", () => {
  const limited = {
    type: "app_rate_limited",
    team_id: "T1",
    api_app_id: "A1",
    minute_rate_limited: 1,
  };
  expect(readFrame(JSON.stringify(limited))).toMatchObject({
    kind: "rate_limited",
    envelopeId: null,
  });
  expect(readFrame(frame(limited))).toMatchObject({ kind: "rate_limited", envelopeId: "env1" });
  expect(readFrame(frame(callback))).toMatchObject({ kind: "event", envelopeId: "env1" });
});
test("malformed frames retain ack identity without content, and lists retain absent versus empty", () => {
  const result = readFrame(frame({ ...callback, authorizations: "private content" }));
  expect(result).toMatchObject({
    kind: "malformed",
    envelopeId: "env1",
  });
  expect(JSON.stringify(result)).not.toContain("private content");
  for (const [authorizations, expected] of [
    [undefined, null],
    [[], []],
  ]) {
    expect(readFrame(frame({ ...callback, authorizations }))).toMatchObject({
      kind: "event",
      callback: { authorizations: expected },
    });
  }
});
