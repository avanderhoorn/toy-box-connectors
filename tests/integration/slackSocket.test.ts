import { expect, onTestFinished, test } from "bun:test";
import type { SocketFrame } from "@slackapi/model/envelopes";
import { openSlackSocket } from "@slackapi/server/socketMode";
import { startFakeSlack } from "../fakes/slack";
import { waitFor } from "./waitFor";

function setup(pingTimeoutMs?: number) {
  const slack = startFakeSlack();
  onTestFinished(() => slack.stop());
  const frames: SocketFrame[] = [];
  const socket = openSlackSocket(slack.appToken, {
    slackApiUrl: slack.url,
    onFrame: (frame) => frames.push(frame),
    pingTimeoutMs,
  });
  onTestFinished(() => socket.close());
  return { slack, socket, frames };
}
test("raw delivery preserves hello, rate limits and acknowledgements, then closes without reconnecting", async () => {
  const { slack, socket, frames } = setup();
  expect(await socket.opened).toEqual({ kind: "open" });
  slack.sendFrame({
    type: "app_rate_limited",
    team_id: "TFAKE",
    api_app_id: "AFAKE",
    minute_rate_limited: 1,
  });
  const delivery = slack.sendEvent({
    type: "message",
    channel: "C1",
    ts: "1.1",
    user: "U1",
    text: "question",
  });
  await waitFor(() => expect(frames).toHaveLength(3));
  socket.ack(delivery.envelopeId);
  expect(await slack.waitForAck(delivery.envelopeId)).toMatchObject({
    body: { envelope_id: delivery.envelopeId },
  });
  expect(frames.map((frame) => frame.kind)).toEqual(["hello", "rate_limited", "event"]);
  slack.disconnect();
  await socket.closed;
  expect(slack.calls.filter((call) => call.method === "apps.connections.open")).toHaveLength(1);
});
test("unanswered pings end the connection, and close before opening also settles", async () => {
  const { slack, socket } = setup(100);
  await socket.opened;
  slack.setSocketResponsive(false);
  await socket.closed;
  const next = openSlackSocket(slack.appToken, { slackApiUrl: slack.url, onFrame() {} });
  onTestFinished(() => next.close());
  next.close();
  expect(await next.opened).toEqual({ kind: "closed" });
  await next.closed;
});
test("a failed apps.connections.open makes one attempt, not an SDK reconnect loop", async () => {
  const slack = startFakeSlack();
  onTestFinished(() => slack.stop());
  slack.failNext("apps.connections.open", { retryAfter: 5 });
  const socket = openSlackSocket(slack.appToken, { slackApiUrl: slack.url, onFrame() {} });
  onTestFinished(() => socket.close());
  expect(await socket.opened).toMatchObject({ kind: "failed", failure: { kind: "rate_limited" } });
  await socket.closed;
  expect(slack.calls).toHaveLength(1);
});
