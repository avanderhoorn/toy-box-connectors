import { expect, test } from "bun:test";
import { sleep } from "./sleep";

test("waits the time it's given", async () => {
  const startedAt = performance.now();
  await sleep(30, new AbortController().signal);
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(25);
});

test("ends when its signal aborts", async () => {
  const stopping = new AbortController();
  const slept = sleep(60_000, stopping.signal);
  stopping.abort();
  expect(await slept).toBeUndefined();
});

test("doesn't wait once its signal has aborted", async () => {
  const stopping = new AbortController();
  stopping.abort();
  expect(await sleep(60_000, stopping.signal)).toBeUndefined();
});
