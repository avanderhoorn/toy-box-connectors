import { expect, test } from "bun:test";
import type { SlackCall } from "../server/botClient";
import { judgeDeletion, judgeProcessing, type Processing } from "./uploads";

const processed = {
  id: "F1",
  name: "image-1.png",
  mimetype: "image/png",
  filetype: "png",
  original_w: 640,
  original_h: 480,
};

test.each<[string, SlackCall<unknown>, Processing]>([
  [
    "an image is ready once Slack gives its size, even as strings",
    {
      kind: "ok",
      result: { ok: true, file: { ...processed, original_w: "640", original_h: "480" } },
    },
    { kind: "ready" },
  ],
  [
    "but not while Slack gives its type and no size",
    {
      kind: "ok",
      result: { ok: true, file: { ...processed, original_w: undefined, original_h: undefined } },
    },
    { kind: "processing" },
  ],
])("%s", (_, call, processing) => {
  expect(judgeProcessing(call)).toEqual(processing);
});

test.each<[string, SlackCall<unknown>]>([
  ["a file Slack deletes is gone", { kind: "ok", result: { ok: true } }],
  [
    "and so is one Slack already deleted",
    { kind: "error", error: "file_deleted", data: { ok: false } },
  ],
])("%s", (_, call) => {
  expect(judgeDeletion(call)).toEqual({ kind: "deleted" });
});
