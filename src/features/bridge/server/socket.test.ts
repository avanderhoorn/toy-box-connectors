import { expect, onTestFinished, spyOn, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "./testFixtures";
import { listenForCommands, type CommandSocketOptions } from "./socket";

function ask(path: string): Promise<string> {
  return fetch("http://bridge/", { unix: path }).then(
    (response) => response.text(),
    (error: { code?: string }) => `refused: ${error.code}`,
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

test("keeps a call open for twice as long as the CLI waits for its answer", async () => {
  const serve = spyOn(Bun, "serve");
  onTestFinished(() => serve.mockRestore());
  const path = join(createTestFolder(), "bridge.sock");
  listen(path, async () => new Response("answered"));

  expect(serve.mock.calls[0]?.[0]).toMatchObject({ unix: path, idleTimeout: 120 });
  expect(await ask(path)).toBe("answered");
});
