import { expect, test } from "bun:test";
import type { SlackCall } from "../server/botClient";
import { judgeFileInfo, type FileInfoVerdict } from "./files";

const ts = "1700000100.000100";
const info = {
  id: "F1",
  name: "build.png",
  title: "build.png",
  mimetype: "image/png",
  filetype: "png",
  pretty_type: "PNG",
  mode: "hosted",
  is_external: false,
  size: 412_000,
  user: "U-alice",
  url_private: "https://files.slack.com/files-pri/T-home-F1/build.png",
  url_private_download: "https://files.slack.com/files-pri/T-home-F1/download/build.png",
  shares: { private: { "C-link": [{ ts, channel_name: "toy-box-private", team_id: "T-home" }] } },
};

test.each<[string, SlackCall<unknown>, FileInfoVerdict]>([
  [
    "a file shared in a private channel reads",
    { kind: "ok", result: { ok: true, file: info } },
    {
      kind: "file",
      file: {
        id: "F1",
        whole: true,
        name: "build.png",
        mimeType: "image/png",
        mode: "hosted",
        size: 412_000,
        uploaderId: "U-alice",
        url: info.url_private_download,
      },
    },
  ],
  [
    "but not once only another message, or another channel's, shares it",
    {
      kind: "ok",
      result: {
        ok: true,
        file: {
          ...info,
          shares: {
            private: { "C-link": [{ ts: "1700000100.000101" }] },
            public: { "C-other": [{ ts }] },
          },
        },
      },
    },
    { kind: "refused", reason: "its message no longer shares it" },
  ],
  [
    "nor when Slack doesn't hold it",
    {
      kind: "ok",
      result: {
        ok: true,
        file: {
          ...info,
          mode: "external",
          is_external: true,
          filetype: "remote",
          url_private: "https://example.com/build.png",
          url_private_download: undefined,
        },
      },
    },
    { kind: "refused", reason: "it's stored outside Slack" },
  ],
  [
    "and a missing scope says how to add it",
    { kind: "error", error: "missing_scope", data: { ok: false } },
    {
      kind: "refused",
      reason:
        "the Slack app doesn't have the files:read scope yet. Ask the owner to add it on the app's OAuth & Permissions page and reinstall the app to the workspace",
    },
  ],
])("%s", (_, call, verdict) => {
  expect(judgeFileInfo(call, { channelId: "C-link", ts })).toEqual(verdict);
});
