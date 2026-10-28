import { describe, expect, onTestFinished, test } from "bun:test";
import {
  fetchToyBoxCatalog,
  readChannelStream,
  runToyBoxRoutine,
  ToyBoxResponseError,
} from "@toybox/server/api";
import { readToyBoxChannel } from "@toybox/server/channel";
import { startFakeToyBox } from "../fakes/toybox";
import { waitFor } from "./waitFor";

function startToyBox() {
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  return { toyBox, origin: new URL(toyBox.url) };
}

/** A loopback server that answers every request with `answer`. */
function serveAnswer(answer: () => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: answer });
  onTestFinished(() => server.stop(true));
  return new URL(server.url);
}

async function readFirstChunk(stream: AsyncGenerator<Uint8Array>) {
  try {
    return (await stream.next()).value;
  } finally {
    await stream.return(undefined);
  }
}

test("running a routine reports what Toy Box did with it", async () => {
  const { toyBox, origin } = startToyBox();
  const channelId = toyBox.addChannel();
  const routine = toyBox.scheduleRoutine(channelId, {
    title: "Slack requests",
    schedule: "0 9 * * 1-5",
    prompt: "Run `toy-box-slack inbox`.",
  });

  expect(await runToyBoxRoutine(origin, channelId, routine.id)).toBe("ran");
  expect(await runToyBoxRoutine(origin, channelId, "deleted-routine")).toBe("missing");
  expect(await runToyBoxRoutine(origin, "deleted-channel", routine.id)).toBe("missing");
  toyBox.failNextRun(500);
  expect(await runToyBoxRoutine(origin, channelId, routine.id)).toBe("failed");
  toyBox.failNextRun(409);
  expect(await runToyBoxRoutine(origin, channelId, routine.id)).toBe("refused");
  expect(toyBox.runs).toEqual([
    { channelId, routineId: routine.id, by: "api", at: expect.any(Number) },
  ]);

  await toyBox.stop();
  expect(await runToyBoxRoutine(origin, channelId, routine.id)).toBe("failed");
});

test("a routine run isn't redirected anywhere else", async () => {
  let redirected = false;
  const elsewhere = serveAnswer(() => {
    redirected = true;
    return new Response(null, { status: 204 });
  });
  const origin = serveAnswer(() => Response.redirect(elsewhere.href, 307));

  expect(await runToyBoxRoutine(origin, "channel", "routine")).toBe("refused");
  expect(redirected).toBe(false);
});

test("the catalog lists each channel's provider and its members", async () => {
  const { toyBox, origin } = startToyBox();
  const channelId = toyBox.addChannel({ provider: "claude" });
  const memberId = toyBox.addMember(channelId, "Reviewer");
  toyBox.startTurn(channelId);

  expect(await fetchToyBoxCatalog(origin)).toEqual({
    version: 1,
    channels: [{ id: channelId, name: "Linked", model: { provider: "claude" } }],
    members: [{ id: memberId, channelId, name: "Reviewer" }],
    working: [channelId],
  });
});

test("a catalog Toy Box doesn't serve fails with its status", async () => {
  const origin = serveAnswer(() => new Response("Not Found", { status: 404 }));

  await expect(fetchToyBoxCatalog(origin)).rejects.toMatchObject({
    name: "ToyBoxResponseError",
    message: "Toy Box answered 404 for its channel list.",
    status: 404,
  });
});

test("a stream resumes after the revision it's given", async () => {
  const { toyBox, origin } = startToyBox();
  const channelId = toyBox.addChannel();
  toyBox.postOwnerMessage(channelId, "First");
  toyBox.postOwnerMessage(channelId, "Second");
  const signal = new AbortController().signal;

  const chunk = await readFirstChunk(
    readChannelStream(origin, channelId, 1, { signal, idleTimeout: 1_000 }),
  );

  expect(new TextDecoder().decode(chunk)).toStartWith("retry: 1000");
  expect(toyBox.streamRequests).toEqual([{ channelId, after: "1", answer: "resumed" }]);
});

test("a stream that isn't an event stream fails with its status", async () => {
  const { origin } = startToyBox();
  const signal = new AbortController().signal;
  const json = serveAnswer(() => Response.json({ channels: [] }));
  const moved = serveAnswer(() => Response.redirect("http://127.0.0.1:1/", 302));

  await expect(
    readFirstChunk(readChannelStream(origin, " ", null, { signal, idleTimeout: 1_000 })),
  ).rejects.toBeInstanceOf(ToyBoxResponseError);
  await expect(
    readFirstChunk(readChannelStream(origin, " ", null, { signal, idleTimeout: 1_000 })),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    readFirstChunk(readChannelStream(json, "channel", null, { signal, idleTimeout: 1_000 })),
  ).rejects.toMatchObject({
    message: expect.stringMatching(
      /^Toy Box answered 200 application\/json.* for channel channel's stream\.$/,
    ),
    status: 200,
  });
  await expect(
    readFirstChunk(readChannelStream(moved, "channel", null, { signal, idleTimeout: 1_000 })),
  ).rejects.toMatchObject({ status: 302 });
});

test("a stream Toy Box never answers fails after the idle timeout", async () => {
  const origin = serveAnswer(() => new Promise<Response>(() => {}));
  const signal = new AbortController().signal;
  const started = Date.now();

  await expect(
    readFirstChunk(readChannelStream(origin, "channel", null, { signal, idleTimeout: 50 })),
  ).rejects.toThrow("Toy Box sent nothing on channel channel's stream for 50 ms.");
  expect(Date.now() - started).toBeLessThan(1_000);
});

describe("reading a channel", () => {
  const signal = new AbortController().signal;

  /** A loopback server that starts every stream with `data` and then stays quiet. */
  function serveStream(data: string) {
    return serveAnswer(
      () =>
        new Response(
          new ReadableStream({ start: (stream) => stream.enqueue(`data: ${data}\n\n`) }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
  }

  test("shows its provider, its routines and when the owner last spoke, and lets go", async () => {
    const spokeAt = Date.parse("2026-10-27T09:00:00Z");
    const toyBox = startFakeToyBox({ now: () => spokeAt });
    onTestFinished(() => toyBox.stop());
    const channelId = toyBox.addChannel({ provider: "claude" });
    const routine = toyBox.scheduleRoutine(channelId, {
      title: "Slack requests",
      schedule: "0 9 * * 1-5",
      prompt: "Run `toy-box-slack inbox`.",
    });
    toyBox.postOwnerMessage(channelId, "Link #release-eng");

    expect(await readToyBoxChannel(new URL(toyBox.url), channelId, { signal })).toEqual({
      provider: "claude",
      ownerSpokeAt: spokeAt,
      routines: [routine],
    });
    expect(toyBox.streamRequests).toEqual([{ channelId, after: null, answer: "snapshot" }]);
    await waitFor(() => expect(toyBox.connections(channelId)).toBe(0));
  });

  test("a channel Toy Box deleted reads as null", async () => {
    const { toyBox, origin } = startToyBox();
    const channelId = toyBox.addChannel();
    toyBox.deleteChannel(channelId);

    expect(await readToyBoxChannel(origin, channelId, { signal })).toBeNull();
  });

  test("a stream that starts with anything but a snapshot fails", async () => {
    const resumed = serveStream(JSON.stringify({ type: "resumed", presence: {} }));
    const unreadable = serveStream("{");

    await expect(readToyBoxChannel(resumed, "channel", { signal })).rejects.toThrow(
      "Toy Box started channel channel's stream without a snapshot.",
    );
    await expect(readToyBoxChannel(unreadable, "channel", { signal })).rejects.toThrow(
      "Toy Box started channel channel's stream without a snapshot.",
    );
  });

  test("a stream Toy Box refuses or ends at once fails", async () => {
    const { toyBox, origin } = startToyBox();
    const channelId = toyBox.addChannel();
    toyBox.refuseStreams(503);
    const ended = serveAnswer(
      () => new Response("", { headers: { "Content-Type": "text/event-stream" } }),
    );

    await expect(readToyBoxChannel(origin, channelId, { signal })).rejects.toMatchObject({
      status: 503,
    });
    await expect(readToyBoxChannel(ended, "channel", { signal })).rejects.toThrow(
      "Toy Box closed channel channel's stream before it sent anything.",
    );
  });

  test("a read Toy Box hasn't answered when its signal aborts fails then", async () => {
    const stalled = serveAnswer(() => new Promise<Response>(() => {}));
    const started = Date.now();

    await expect(
      readToyBoxChannel(stalled, "channel", { signal: AbortSignal.timeout(50) }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
