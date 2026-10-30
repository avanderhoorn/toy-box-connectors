import { expect, test } from "bun:test";
import { sleep } from "./sleep";

test("waits the time it's given", async () => {
  const startedAt = performance.now();
  await sleep(30, new AbortController().signal);
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(25);
});

test("ends when its signal aborts, at once if it already has", async () => {
  const stopping = new AbortController();
  const slept = sleep(60_000, stopping.signal);
  stopping.abort();
  expect(await slept).toBeUndefined();
  expect(await sleep(60_000, stopping.signal)).toBeUndefined();
});
