import { expect, onTestFinished, test } from "bun:test";
import {
  fetchToyBoxCatalog,
  readChannelStream,
  runToyBoxRoutine,
  ToyBoxResponseError,
} from "@toybox/server/api";
import { startFakeToyBox } from "../fakes/toybox";

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
