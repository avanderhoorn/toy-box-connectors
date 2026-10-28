// Waking a lead through a fake Toy Box that answers the way the real handlers do.

import { expect, onTestFinished, spyOn, test } from "bun:test";
import { readToyBoxChannel, runToyBoxRoutine } from "@toybox/server/api";
import { wakeLead } from "@toybox/server";
import { startFakeToyBox } from "../fakes/toybox";
import { REQUESTS_ROUTINE } from "./linkedBridge";
import { waitFor } from "./waitFor";

function startToyBox() {
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  return { toyBox, origin: new URL(toyBox.url) };
}

/** Keeps what the bridge logs, rather than printing it. */
function captureLog() {
  const log = spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());
  return () => log.mock.calls.map((call) => call.join(" "));
}

test("waking a lead runs the routine whose prompt runs inbox, and lets go of the channel's stream", async () => {
  const { toyBox, origin } = startToyBox();
  const channelId = toyBox.addChannel();
  toyBox.scheduleRoutine(channelId, { ...REQUESTS_ROUTINE, prompt: "Summarize the week." });
  const routine = toyBox.scheduleRoutine(channelId, REQUESTS_ROUTINE);

  expect(await wakeLead(origin, channelId)).toBe("ran");
  expect(toyBox.runs).toEqual([{ channelId, routineId: routine.id, at: expect.any(Number) }]);
  await waitFor(() => expect(toyBox.openStreams()).toBe(0));
});

test("reading a channel gives its title, its lead's provider and its routines, or null once it's gone", async () => {
  const { toyBox, origin } = startToyBox();
  const channelId = toyBox.addChannel({ name: "Releases", provider: "codex" });
  const routine = toyBox.scheduleRoutine(channelId, REQUESTS_ROUTINE);
  const deleted = toyBox.addChannel();
  toyBox.deleteChannel(deleted);

  expect(await readToyBoxChannel(origin, channelId)).toEqual({
    name: "Releases",
    provider: "codex",
    routines: [routine],
  });
  expect(await readToyBoxChannel(origin, deleted)).toBeNull();
  await waitFor(() => expect(toyBox.openStreams()).toBe(0));
});

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
