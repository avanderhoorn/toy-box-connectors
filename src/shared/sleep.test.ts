import { expect, test } from "bun:test";
import { sleep } from "./sleep";

test("ends when its signal aborts, at once if it already has", async () => {
  const stopping = new AbortController();
  const slept = sleep(60_000, stopping.signal);
  stopping.abort();
  expect(await slept).toBeUndefined();
  expect(await sleep(60_000, stopping.signal)).toBeUndefined();
});
