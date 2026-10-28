import { expect, onTestFinished, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "./testFixtures";
import { listenForCommands } from "./socket";

function ask(path: string): Promise<string> {
  return fetch("http://bridge/", { unix: path }).then(
    (response) => response.text(),
    (error: { code?: string }) => `refused: ${error.code}`,
  );
}

function listen(path: string, answer: () => Promise<Response>, grace?: number) {
  const socket = listenForCommands(path, answer, { grace });
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
  const hung = listen(join(folder, "hung.sock"), () => new Promise(() => {}), 50);
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
