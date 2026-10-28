import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { Banner } from "./banner";
import { commandContract } from "./contract";
import { explain, explainNoAnswer, readAnswer, readCallFailure, type NoAnswer } from "./outcome";

const AT = Date.parse("2026-10-27T16:00:00Z");

const healthy: Banner = { slack: "connected", coverage: "complete", warnings: [], restore: null };

const reply = commandContract({
  description: "Reply in a Slack thread",
  roles: ["lead"],
  scope: "channel",
  input: z.object({ text: z.string() }).strict(),
  result: z.object({ posted: z.string() }).strict(),
  present: (result, { at }) => `Posted ${result.posted} at ${at}.`,
});

const address = {
  dataFolder: "/Users/ada/.toy-box-slack",
  socket: "/Users/ada/.toy-box-slack/bridge.sock",
};

describe("reading the bridge's answer", () => {
  test("a command that ran prints its result under the banner, and --json prints the answer", () => {
    const body = { version: 1, at: AT, banner: healthy, result: { posted: "p-1" } };

    expect(readAnswer("reply", reply, { status: 200, body })).toEqual({
      exitCode: 0,
      text: `> Slack: connected · coverage complete\n\nPosted p-1 at ${AT}.`,
      json: body,
      result: { posted: "p-1" },
    });
  });

  test("a refusal prints why under the banner, or alone when the caller itself was refused", () => {
    const refused = { rule: "not_allowed", message: "Only the lead can reply." };
    const withBanner = { version: 1, at: AT, banner: healthy, refused };
    const withoutBanner = { ...withBanner, banner: null };

    expect(readAnswer("reply", reply, { status: 409, body: withBanner })).toEqual({
      exitCode: 1,
      text: "> Slack: connected · coverage complete\n\nOnly the lead can reply.",
      json: withBanner,
    });
    expect(readAnswer("reply", reply, { status: 403, body: withoutBanner })).toEqual({
      exitCode: 1,
      text: "Only the lead can reply.",
      json: withoutBanner,
    });
    expect(readAnswer("reply", reply, { status: 503, body: withBanner }).exitCode).toBe(1);
  });

  test("an error the bridge explained is printed as it said it", () => {
    const body = { error: "The bridge couldn't finish `reply`. Its log says why." };

    expect(readAnswer("reply", reply, { status: 500, body })).toEqual({
      exitCode: 1,
      text: body.error,
      json: body,
    });
  });

  test("a command the bridge doesn't have means it runs another release", () => {
    const body = { error: "The bridge has no command `reply`." };

    expect(readAnswer("reply", reply, { status: 404, body })).toEqual(
      explain(
        1,
        "The bridge runs a release of toy-box-slack without `reply`, so it didn't run. Whoever runs the bridge can restart it to run the same release as this CLI.",
      ),
    );
  });

  const releases =
    "That happens when the bridge runs another release of toy-box-slack. Whoever runs the bridge can restart it to run the same release as this CLI.";

  test.each([
    ["another protocol", 200, { version: 2, at: AT, banner: healthy, result: { posted: "p-1" } }],
    [
      "a result the contract doesn't allow",
      200,
      { version: 1, at: AT, banner: healthy, result: {} },
    ],
    ["no JSON", 200, null],
  ])("an answer with %s says the command ran but can't be read", (_, status, body) => {
    expect(readAnswer("reply", reply, { status, body })).toEqual(
      explain(1, `\`reply\` ran, but this CLI can't read the bridge's answer. ${releases}`),
    );
  });

  test.each([
    [409, { refused: "no" }],
    [404, "Not Found"],
  ])("an unreadable %i says the bridge refused", (status, body) => {
    expect(readAnswer("reply", reply, { status, body })).toEqual(
      explain(1, `The bridge refused \`reply\`, but this CLI can't read why. ${releases}`),
    );
  });

  test.each([500, 502, 302])("an unreadable %i may or may not have run", (status) => {
    expect(readAnswer("reply", reply, { status, body: null })).toEqual(
      explain(
        1,
        "The bridge couldn't finish `reply`, so it may or may not have run, and this CLI can't read why. Check `toy-box-slack status` before you run `reply` again.",
      ),
    );
  });
});

describe("reading why a call failed", () => {
  function failure(code: string): Error {
    return Object.assign(new Error(`${code}: Was there a typo in the url or port?`), { code });
  }

  test.each<[string, NoAnswer["kind"]]>([
    ["ENOENT", "missing"],
    ["ENOTDIR", "missing"],
    ["ENAMETOOLONG", "missing"],
    ["ECONNREFUSED", "stopped"],
    ["ENOTSOCK", "not_socket"],
    ["EACCES", "denied"],
    ["EPERM", "denied"],
    ["ECONNRESET", "lost"],
    ["EPIPE", "lost"],
  ])("%s means %s", (code, kind) => {
    expect(readCallFailure(failure(code), 60_000)).toEqual({ kind } as NoAnswer);
  });

  test("a timeout says how long the CLI waited, in whole seconds", () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");

    expect(readCallFailure(timeout, 60_000)).toEqual({ kind: "timed_out", seconds: 60 });
    expect(readCallFailure(timeout, 50)).toEqual({ kind: "timed_out", seconds: 1 });
  });

  test("anything else can't prove the bridge never saw the call", () => {
    expect(readCallFailure(failure("EIO"), 60_000)).toEqual({
      kind: "failed",
      reason: "EIO: Was there a typo in the url or port?",
    });
    expect(readCallFailure("broken", 60_000)).toEqual({ kind: "failed", reason: "broken" });
    expect(readCallFailure(undefined, 60_000)).toEqual({ kind: "failed", reason: "undefined" });
  });
});

describe("explaining a call without an answer", () => {
  const start = "Whoever runs the bridge can start it with `toy-box-slack serve`.";
  const check = "Check `toy-box-slack status` before you run `reply` again.";

  test.each<[NoAnswer, 1 | 2, string]>([
    [
      { kind: "missing" },
      2,
      `No bridge is running for /Users/ada/.toy-box-slack, so \`reply\` didn't run. ${start}`,
    ],
    [
      { kind: "stopped" },
      2,
      `The bridge for /Users/ada/.toy-box-slack has stopped, so \`reply\` didn't run. ${start}`,
    ],
    [
      { kind: "not_socket" },
      2,
      "Something other than the bridge's socket is at /Users/ada/.toy-box-slack/bridge.sock, so `reply` didn't run. Whoever runs the bridge can remove it and start the bridge with `toy-box-slack serve`.",
    ],
    [
      { kind: "denied" },
      2,
      "This user can't open /Users/ada/.toy-box-slack/bridge.sock, so `reply` didn't run. Run it as the user who runs the bridge.",
    ],
    [
      { kind: "lost" },
      1,
      `The bridge closed the connection before it answered \`reply\`, so it may or may not have run. ${check}`,
    ],
    [
      { kind: "timed_out", seconds: 60 },
      1,
      `The bridge didn't answer \`reply\` within 60 seconds, so it may or may not have run. ${check}`,
    ],
    [
      { kind: "timed_out", seconds: 1 },
      1,
      `The bridge didn't answer \`reply\` within 1 second, so it may or may not have run. ${check}`,
    ],
    [
      { kind: "failed", reason: "EIO" },
      1,
      `The call to \`reply\` failed (EIO), so it may or may not have run. ${check}`,
    ],
  ])("%o exits %i", (noAnswer, exitCode, message) => {
    expect(explainNoAnswer("reply", noAnswer, address)).toEqual({
      exitCode,
      text: message,
      json: { error: message },
    });
  });
});
