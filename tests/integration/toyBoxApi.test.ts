// Waking a lead through a fake Toy Box that answers the way the real handlers do.

import { expect, onTestFinished, spyOn, test } from "bun:test";
import { captureLog } from "@bridge/server/testFixtures";
import { runToyBoxRoutine } from "@toybox/server/api";
import { wakeLead } from "@toybox/server";
import { startFakeToyBox } from "../fakes/toybox";
import { REQUESTS_ROUTINE } from "./linkedBridge";

function startToyBox() {
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  return { toyBox, origin: new URL(toyBox.url) };
}

test("a wake Toy Box can't run says why, and logs what the owner needs to fix it", async () => {
  const { toyBox, origin } = startToyBox();
  const log = captureLog();
  const unrouted = toyBox.addChannel();
  toyBox.scheduleRoutine(unrouted, { ...REQUESTS_ROUTINE, prompt: "Summarize the week." });
  const deleted = toyBox.addChannel();
  toyBox.deleteChannel(deleted);
  const channelId = toyBox.addChannel();
  toyBox.scheduleRoutine(channelId, REQUESTS_ROUTINE);

  expect(await wakeLead(origin, unrouted)).toBe("missing");
  expect(await wakeLead(origin, deleted)).toBe("missing");
  toyBox.failNextRun(500);
  expect(await wakeLead(origin, channelId)).toBe("failed");
  toyBox.failNextRun(400);
  expect(await wakeLead(origin, channelId)).toBe("refused");
  await toyBox.stop();
  expect(await wakeLead(origin, channelId)).toBe("failed");

  expect(toyBox.runs).toEqual([]);
  expect(log()).toEqual([
    expect.stringContaining("Toy Box answered 500 to running routine"),
    expect.stringContaining("Toy Box answered 400 to running routine"),
    expect.stringContaining(`Calling Toy Box for channel ${channelId} failed:`),
  ]);
});

test("a wake gives its read 15 seconds, and its run 60", async () => {
  const { toyBox, origin } = startToyBox();
  const channelId = toyBox.addChannel();
  toyBox.scheduleRoutine(channelId, REQUESTS_ROUTINE);
  const timeouts = spyOn(AbortSignal, "timeout");
  onTestFinished(() => timeouts.mockRestore());

  expect(await wakeLead(origin, channelId)).toBe("ran");

  expect(timeouts.mock.calls).toEqual([[15_000], [60_000]]);
});

test("a run Toy Box answers after the time a read gets still counts as ran, and runs once", async () => {
  const { toyBox, origin } = startToyBox();
  const log = captureLog();
  const channelId = toyBox.addChannel();
  toyBox.scheduleRoutine(channelId, REQUESTS_ROUTINE);
  const release = toyBox.holdNext("run");
  setTimeout(release, 150);

  expect(await wakeLead(origin, channelId, undefined, { readMs: 50 })).toBe("ran");

  expect(toyBox.runs).toHaveLength(1);
  expect(log()).toEqual([]);
});

test("a run Toy Box doesn't answer within its own time fails, though Toy Box may deliver it", async () => {
  const { toyBox, origin } = startToyBox();
  const log = captureLog();
  const channelId = toyBox.addChannel();
  toyBox.scheduleRoutine(channelId, REQUESTS_ROUTINE);
  toyBox.holdNext("run");

  expect(await wakeLead(origin, channelId, undefined, { runMs: 100 })).toBe("failed");

  // The delivery is why the retry can wake the lead twice.
  expect(toyBox.runs).toHaveLength(1);
  expect(log()).toEqual([
    expect.stringContaining(`Calling Toy Box for channel ${channelId} failed:`),
  ]);
});

test("a read Toy Box doesn't answer within its time fails without running anything", async () => {
  const { toyBox, origin } = startToyBox();
  captureLog();
  const channelId = toyBox.addChannel();
  toyBox.scheduleRoutine(channelId, REQUESTS_ROUTINE);
  toyBox.holdNext("read");

  expect(await wakeLead(origin, channelId, undefined, { readMs: 100 })).toBe("failed");

  expect(toyBox.runs).toEqual([]);
});

test("a wake isn't redirected anywhere else", async () => {
  captureLog();
  let redirected = false;
  const elsewhere = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      redirected = true;
      return new Response(null, { status: 204 });
    },
  });
  const origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.redirect(elsewhere.url.href, 307),
  });
  onTestFinished(() => Promise.all([elsewhere.stop(true), origin.stop(true)]));

  expect(await wakeLead(origin.url, "channel")).toBe("failed");
  expect(await runToyBoxRoutine(origin.url, "channel", "routine")).toBe("failed");
  expect(redirected).toBe(false);
});
