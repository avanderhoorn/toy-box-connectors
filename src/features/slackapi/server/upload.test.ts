import { expect, test } from "bun:test";
import type { Fetch } from "./download";
import { uploadFile, type Upload } from "./upload";

const url = "https://files.slack.com/upload/v1/CwABAAAAXAoAAZnKg2pGAh";
const bytes = new Uint8Array([137, 80, 78, 71, 13]);
const taken = async () => new Response(`OK - ${bytes.length}`);

test.each<[string, string, Fetch, string]>([
  [
    "the bytes never go to a host that only looks like Slack's",
    "https://files.slack.com.example.com/upload/v1/CwABAAAAXAoAAZnKg2pGAh",
    taken,
    "Slack gave an address off its file host",
  ],
  [
    "or over plain HTTP",
    "http://files.slack.com/upload/v1/CwABAAAAXAoAAZnKg2pGAh",
    taken,
    "Slack gave an address off its file host",
  ],
  [
    "or wherever a redirect leads",
    url,
    // Like fetch, it follows a redirect unless told not to, and answers for where it led.
    async (_, init) =>
      init.redirect === "manual"
        ? new Response(null, { status: 307, headers: { location: "https://example.com/" } })
        : taken(),
    "Slack answered with HTTP 307",
  ],
  [
    "a stall times out",
    url,
    (_, init) =>
      new Promise((_, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
      ),
    "Slack took too long to receive it, so try again shortly",
  ],
  [
    "and no reason repeats what fetch said, which can name the address",
    url,
    async () => {
      throw new TypeError(`fetch failed for ${url}`);
    },
    "Slack didn't receive it, so try again shortly",
  ],
])("%s", async (_, address, fetch, reason) => {
  expect(await uploadFile({ url: address, bytes }, { fetch, timeoutMs: 100 })).toEqual<Upload>({
    kind: "refused",
    reason,
  });
});
