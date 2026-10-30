// A file's bytes, fetched from where Slack serves them with the bot's token.
//
// files.info gives the address, and the token goes only to Slack's file host, over HTTPS, so an
// address on any other host never sees it. Redirects aren't followed, since one could lead
// anywhere, and only a 200 is read. Its body must be exactly the size files.info gave, which also
// refuses a sign-in page in its place, and reading stops a byte past that size, so an endless
// body costs at most one chunk more. Fetch's errors can name the address, so every failure
// becomes a fixed reason.

/** Where Slack serves files' bytes, and the one origin the bridge sends its token to for them. */
export const slackFilesOrigin = "https://files.slack.com";
export const downloadTimeoutMs = 20_000;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** A file's bytes, or why the bridge couldn't read them. A reason follows "can't be read since". */
export type Download = { kind: "bytes"; bytes: Uint8Array } | { kind: "refused"; reason: string };

/** Reads the `size` bytes files.info gave for the file at `url`. */
export async function downloadFile(
  { url, size, token }: { url: string; size: number; token: string },
  {
    origin = slackFilesOrigin,
    fetch = globalThis.fetch,
    timeoutMs = downloadTimeoutMs,
  }: { origin?: string; fetch?: Fetch; timeoutMs?: number } = {},
): Promise<Download> {
  if (URL.parse(url)?.origin !== origin) return refused("Slack gave an address off its file host");
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
      signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return refused(`Slack answered with HTTP ${response.status}`);
    }
    return await readExactly(response.body, size);
  } catch {
    return refused(
      signal.aborted
        ? "Slack took too long to send it, so try again shortly"
        : "Slack didn't send it, so try again shortly",
    );
  }
}

async function readExactly(
  body: ReadableStream<Uint8Array> | null,
  size: number,
): Promise<Download> {
  const bytes = new Uint8Array(size);
  let read = 0;
  if (body) {
    for await (const chunk of body) {
      if (read + chunk.length > size) return refused(wrongSize);
      bytes.set(chunk, read);
      read += chunk.length;
    }
  }
  return read === size ? { kind: "bytes", bytes } : refused(wrongSize);
}

const wrongSize = "what Slack sent isn't the size it described";

function refused(reason: string): Download {
  return { kind: "refused", reason };
}
