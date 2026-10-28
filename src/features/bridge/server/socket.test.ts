import { expect, onTestFinished, spyOn, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "./testFixtures";
import { listenForCommands, type CommandSocketOptions } from "./socket";

function ask(path: string, timeout?: number): Promise<string> {
  const signal = timeout === undefined ? undefined : AbortSignal.timeout(timeout);
  return fetch("http://bridge/", { unix: path, signal }).then(
    (response) => response.text(),
    (error: { name?: string; code?: string }) =>
      error.name === "TimeoutError" ? "timed out" : `refused: ${error.code}`,
  );
}

function listen(path: string, answer: () => Promise<Response>, options?: CommandSocketOptions) {
  const socket = listenForCommands(path, answer, options);
  onTestFinished(() => socket.stop());
  return socket;
}

test("only the owner can connect, and stopping removes the socket", async () => {
  const path = join(createTestFolder(), "bridge.sock");
  const umask = process.umask();
  const socket = listen(path, async () => new Response("answered"));

  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(process.umask()).toBe(umask);
  expect(await ask(path)).toBe("answered");
  await socket.stop();
  expect(await ask(path)).toBe("refused: ENOENT");
});

test("replaces a socket a stopped bridge left behind", async () => {
  const path = join(createTestFolder(), "bridge.sock");
  writeFileSync(path, "");

  listen(path, async () => new Response("answered"));
  expect(await ask(path)).toBe("answered");
});

test("works in a data folder deeper than a socket address holds", async () => {
  const folder = join(createTestFolder(), "a".repeat(60), "b".repeat(60));
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "bridge.sock");
  expect(Buffer.byteLength(path)).toBeGreaterThan(104);

  listen(path, async () => new Response("answered"));
  expect(await ask(path)).toBe("answered");
});

test("stopping waits for calls in flight, and cuts them off after the grace period", async () => {
  const folder = createTestFolder();
  const release = Promise.withResolvers<void>();
  const finishing = listen(join(folder, "finishing.sock"), async () => {
    await release.promise;
    return new Response("finished");
  });
  const finished = ask(join(folder, "finishing.sock"));
  const hung = listen(join(folder, "hung.sock"), () => new Promise(() => {}), { grace: 50 });
  const cutOff = ask(join(folder, "hung.sock"));
  await Bun.sleep(20);

  let stopped = false;
  const stopping = finishing.stop().then(() => (stopped = true));
  await Bun.sleep(20);
  expect(stopped).toBe(false);
  expect(await ask(join(folder, "finishing.sock"))).toBe("refused: ENOENT");
  release.resolve();
  expect(await finished).toBe("finished");
  await stopping;

  await hung.stop();
  expect(await cutOff).toBe("refused: ECONNRESET");
});

// Bun looks for idle calls every 4 seconds, so it drops one up to 4 seconds after its idle timeout,
// and its own default of 10 seconds drops one after 8 to 12.
test("drops a call that goes unanswered past its idle timeout", async () => {
  const path = join(createTestFolder(), "bridge.sock");
  listen(path, () => new Promise(() => {}), { idleTimeout: 1_000, grace: 50 });

  expect(await ask(path, 6_000)).toBe("refused: ECONNRESET");
}, 10_000);

test("keeps a call open for twice as long as the CLI waits for its answer", async () => {
  const serve = spyOn(Bun, "serve");
  onTestFinished(() => serve.mockRestore());
  const path = join(createTestFolder(), "bridge.sock");
  listen(path, async () => new Response("answered"));

  expect(serve.mock.calls[0]?.[0]).toMatchObject({ unix: path, idleTimeout: 120 });
  expect(await ask(path)).toBe("answered");
});
