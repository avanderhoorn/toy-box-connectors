import { z } from "zod";
import type { SlackCall } from "../server/botClient";

// Images the bridge uploads, as Slack answers each step.
//
// files.getUploadURLExternal opens an upload and names the file it will be, the bytes go to the
// address it gives, and files.completeUploadExternal with no channel makes them a file only the
// bot can see. Slack then processes the file, and refuses an image block naming it until it has.
// files.info gives an image no size until then, and the test workspace gave a PNG an empty type
// first, so an image is ready once Slack gives its width and height. files.delete removes a file,
// and answers file_deleted or file_not_found for one that's already gone.
// https://docs.slack.dev/messaging/working-with-files/#upload

/** An upload Slack opened. A reason follows "couldn't be uploaded since". */
export type UploadTicket = { kind: "ticket"; fileId: string; url: string } | Refused;
/** Whether Slack made the uploads files. */
export type Completion = { kind: "completed" } | Refused;
/** Whether Slack has processed an uploaded image, so a message can show it. */
export type Processing = { kind: "ready" } | { kind: "processing" } | Refused;
/** Whether Slack deleted a file. */
export type Deletion = { kind: "deleted" } | { kind: "kept" };
type Refused = { kind: "refused"; reason: string };

const ticketSchema = z.object({
  upload_url: z.string().min(1).describe("Where the upload's bytes go"),
  file_id: z.string().min(1).describe("The file the upload becomes"),
});
// Slack's samples give a size as a string, and the test workspace gave numbers.
const size = z.union([z.number(), z.string()]);
const processingSchema = z.object({
  file: z.object({
    original_w: size.nullish().describe("Width, once Slack has processed an image"),
    original_h: size.nullish().describe("Height, once Slack has processed an image"),
  }),
});

/** What files.getUploadURLExternal's answer gives an upload. */
export function judgeUploadTicket(call: SlackCall<unknown>): UploadTicket {
  if (call.kind !== "ok") return refused(failureReason(call, "files:write"));
  const parsed = ticketSchema.safeParse(call.result);
  if (!parsed.success) return refused("Slack's answer couldn't be read");
  return { kind: "ticket", fileId: parsed.data.file_id, url: parsed.data.upload_url };
}

/** Whether files.completeUploadExternal's answer says Slack made the uploads files. */
export function judgeCompletion(call: SlackCall<unknown>): Completion {
  return call.kind === "ok" ? { kind: "completed" } : refused(failureReason(call, "files:write"));
}

/** Whether files.info's answer shows an uploaded image Slack has processed. */
export function judgeProcessing(call: SlackCall<unknown>): Processing {
  if (call.kind !== "ok") return refused(failureReason(call, "files:read"));
  const parsed = processingSchema.safeParse(call.result);
  if (!parsed.success) return refused("Slack's description of it couldn't be read");
  const { original_w, original_h } = parsed.data.file;
  return original_w && original_h ? { kind: "ready" } : { kind: "processing" };
}

/** Whether files.delete's answer says the file is gone, as it is when Slack already deleted it. */
export function judgeDeletion(call: SlackCall<unknown>): Deletion {
  const gone = call.kind === "error" && ["file_not_found", "file_deleted"].includes(call.error);
  return { kind: call.kind === "ok" || gone ? "deleted" : "kept" };
}

function failureReason(call: Exclude<SlackCall<unknown>, { kind: "ok" }>, scope: string): string {
  switch (call.kind) {
    case "rate_limited":
      return "Slack asked the bridge to wait, so try again shortly";
    case "auth_failed":
      return "Slack rejects the bridge's tokens";
    case "unknown":
      return "Slack didn't answer, so try again shortly";
    case "error":
      return call.error === "missing_scope"
        ? `the Slack app doesn't have the ${scope} scope yet. Ask the owner to add it on the app's OAuth & Permissions page and reinstall the app to the workspace`
        : `Slack refused with ${call.error}`;
  }
}

function refused(reason: string): Refused {
  return { kind: "refused", reason };
}
