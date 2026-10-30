// A file's bytes, sent where Slack asked for them.
//
// files.getUploadURLExternal gives an address on Slack's file host that names one upload, so the
// bytes go there raw and without the token, as Slack's guide shows. An address on any other host
// gets nothing, and no redirect is followed, since one could send the bytes anywhere. Only a 200
// means Slack took them. Fetch's errors can name the address, so every failure becomes a fixed
// reason.
// https://docs.slack.dev/messaging/working-with-files/#upload-step-2

import { slackFilesOrigin, type Fetch } from "./download";

export const uploadTimeoutMs = 20_000;

/** Whether Slack took a file's bytes. A reason follows "couldn't be uploaded since". */
export type Upload = { kind: "sent" } | { kind: "refused"; reason: string };

/** Sends `bytes` to the `url` files.getUploadURLExternal gave for them. */
export async function uploadFile(
  { url, bytes }: { url: string; bytes: Uint8Array },
  {
    origin = slackFilesOrigin,
    fetch = globalThis.fetch,
    timeoutMs = uploadTimeoutMs,
  }: { origin?: string; fetch?: Fetch; timeoutMs?: number } = {},
): Promise<Upload> {
  if (URL.parse(url)?.origin !== origin) return refused("Slack gave an address off its file host");
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
      redirect: "manual",
      signal,
    });
    await response.body?.cancel();
    return response.status === 200
      ? { kind: "sent" }
      : refused(`Slack answered with HTTP ${response.status}`);
  } catch {
    return refused(
      signal.aborted
        ? "Slack took too long to receive it, so try again shortly"
        : "Slack didn't receive it, so try again shortly",
    );
  }
}

function refused(reason: string): Upload {
  return { kind: "refused", reason };
}
