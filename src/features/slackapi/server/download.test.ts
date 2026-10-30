import { expect, test } from "bun:test";
import { downloadFile, type Download, type Fetch } from "./download";

const token = "xoxb-test";
const url = "https://files.slack.com/files-pri/T-home-F1/download/build.png";
const file = new Uint8Array([137, 80, 78, 71, 13]);
const chunk = new Uint8Array(2);

test.each<[string, string, (signal: AbortSignal) => Response, string]>([
  [
    "the token never goes to a host that only looks like Slack's",
    "https://files.slack.com.example.com/files-pri/T-home-F1/download/build.png",
    () => new Response(file),
    "Slack gave an address off its file host",
  ],
  [
    "or over plain HTTP",
    "http://files.slack.com/files-pri/T-home-F1/download/build.png",
    () => new Response(file),
    "Slack gave an address off its file host",
  ],
  [
    "a file cut short is refused",
    url,
    () => new Response(file.subarray(0, 4)),
    "what Slack sent isn't the size it described",
  ],
  [
    "as is one that never ends, read no further than past its size",
    url,
    // Like a network body, it arrives a chunk at a time and ends when fetch aborts.
    (signal) =>
      new Response(
        new ReadableStream({
          async pull(stream) {
            await Bun.sleep(1);
            if (signal.aborted) stream.error(signal.reason);
            else stream.enqueue(chunk);
          },
        }),
      ),
    "what Slack sent isn't the size it described",
  ],
  [
    "and one that stalls times out",
    url,
    (signal) =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(file.subarray(0, 2));
            signal.addEventListener("abort", () => stream.error(signal.reason));
          },
        }),
      ),
    "Slack took too long to send it, so try again shortly",
  ],
  [
    "and no reason repeats what fetch said, which can name the address",
    url,
    () => {
      throw new TypeError(`fetch failed for ${url}`);
    },
    "Slack didn't send it, so try again shortly",
  ],
])("%s", async (_, address, serve, reason) => {
  const fetch: Fetch = async (_, init) => serve(init.signal!);
  expect(
    await downloadFile({ url: address, size: file.length, token }, { fetch, timeoutMs: 100 }),
  ).toEqual<Download>({ kind: "refused", reason });
});
