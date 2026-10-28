import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultWakeTimings } from "@wakes/model";
import {
  credentialsFileProblem,
  parseCredentials,
  readCredentialsFile,
  resolveBridgeSettings,
  resolveToyBoxOrigin,
  resolveWakeTimings,
} from "./environment";
import { BridgeRefusedError } from "./refusal";
import { createTestFolder } from "./testFixtures";

const path = "/Users/ada/.toy-box-slack/credentials.env";

/** The whole message `operation` refuses with. */
function refusalOf(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof BridgeRefusedError) return error.message;
    throw error;
  }
  throw new Error("Expected a refusal.");
}

describe("the bridge's settings", () => {
  const file = {
    SLACK_BOT_TOKEN: "xoxb-file",
    SLACK_APP_TOKEN: "xapp-file",
    TOY_BOX_URL: "http://127.0.0.1:3100",
  };

  test("come from credentials.env when the environment leaves them unset", () => {
    expect(resolveBridgeSettings({}, file)).toEqual({
      toyBoxOrigin: new URL("http://127.0.0.1:3100"),
      botToken: "xoxb-file",
      appToken: "xapp-file",
      slackApiUrl: undefined,
      wakeTimings: defaultWakeTimings,
    });
  });

  test("come from the environment first, where an empty variable counts as unset", () => {
    const env = {
      SLACK_BOT_TOKEN: "xoxb-env",
      SLACK_APP_TOKEN: "",
      TOY_BOX_URL: "http://[::1]:3000",
    };

    expect(resolveBridgeSettings(env, file)).toMatchObject({
      toyBoxOrigin: new URL("http://[::1]:3000"),
      botToken: "xoxb-env",
      appToken: "xapp-file",
    });
  });

  test("leave a token neither sets as null, and Toy Box at its default address", () => {
    expect(resolveBridgeSettings({}, {})).toMatchObject({
      toyBoxOrigin: new URL("http://127.0.0.1:3000"),
      botToken: null,
      appToken: null,
    });
  });

  test("check a Toy Box address from credentials.env like one from the environment", () => {
    const settings = () => resolveBridgeSettings({}, { TOY_BOX_URL: "http://10.0.0.2:3000" });

    expect(settings).toThrow(BridgeRefusedError);
    expect(settings).toThrow("TOY_BOX_URL must be an http URL on this Mac");
  });

  test("point Slack at a fake on this Mac only when a test sets SLACK_API_URL", () => {
    const env = { SLACK_API_URL: "http://127.0.0.1:4100/api/" };
    expect(resolveBridgeSettings(env, {}).slackApiUrl).toBe("http://127.0.0.1:4100/api/");

    const remote = () => resolveBridgeSettings({ SLACK_API_URL: "https://slack.com/api/" }, {});
    expect(remote).toThrow(BridgeRefusedError);
    expect(remote).toThrow(
      'SLACK_API_URL is only for tests and must be an http URL on this Mac, but it\'s "https://slack.com/api/".',
    );
  });
});

describe("credentials.env", () => {
  test("holds NAME=value lines, with export, quotes, blank lines and comments allowed", () => {
    const text = [
      "# Slack tokens for the bridge",
      "",
      "SLACK_BOT_TOKEN=xoxb-1",
      'export SLACK_APP_TOKEN = "xapp-2"\r',
      "  TOY_BOX_URL='http://127.0.0.1:3100/?a=b'  ",
    ].join("\n");

    expect(parseCredentials(path, text)).toEqual({
      SLACK_BOT_TOKEN: "xoxb-1",
      SLACK_APP_TOKEN: "xapp-2",
      TOY_BOX_URL: "http://127.0.0.1:3100/?a=b",
    });
    expect(parseCredentials(path, "SLACK_BOT_TOKEN=\n")).toEqual({ SLACK_BOT_TOKEN: "" });
  });

  test("refuses any line it can't read for certain, without repeating the line's value", () => {
    const refusals = {
      "SLACK_BOT_TOKEN xoxb-secret":
        "Line 1 of /Users/ada/.toy-box-slack/credentials.env isn't NAME=value.",
      "=xoxb-secret": "Line 1 of /Users/ada/.toy-box-slack/credentials.env isn't NAME=value.",
      "SLACK BOT TOKEN=xoxb-secret":
        "Line 1 of /Users/ada/.toy-box-slack/credentials.env isn't NAME=value.",
      "SLACK_SIGNING_SECRET=secret":
        "Line 1 of /Users/ada/.toy-box-slack/credentials.env sets SLACK_SIGNING_SECRET, but the file may set only SLACK_BOT_TOKEN, SLACK_APP_TOKEN, TOY_BOX_URL.",
      "SLACK_BOT_TOKEN=xoxb-secret\nSLACK_BOT_TOKEN=xoxb-secret":
        "Line 2 of /Users/ada/.toy-box-slack/credentials.env sets SLACK_BOT_TOKEN again.",
      'SLACK_BOT_TOKEN="xoxb-secret':
        "Line 1 of /Users/ada/.toy-box-slack/credentials.env opens a quote around SLACK_BOT_TOKEN's value without closing it.",
      "SLACK_BOT_TOKEN=xoxb-secret # the bot":
        "Line 1 of /Users/ada/.toy-box-slack/credentials.env gives SLACK_BOT_TOKEN a value with a space in it, which no token or URL has.",
    };
    for (const [text, problem] of Object.entries(refusals)) {
      expect(refusalOf(() => parseCredentials(path, text))).toBe(problem);
    }
  });

  test("must be a file only its owner can read or write", () => {
    const file = (mode: number, uid = 501) => ({ isFile: () => true, mode: 0o100000 | mode, uid });

    expect(credentialsFileProblem(path, file(0o600), 501)).toBeNull();
    expect(credentialsFileProblem(path, file(0o400), 501)).toBeNull();
    for (const mode of [0o640, 0o604, 0o644, 0o620, 0o666]) {
      expect(credentialsFileProblem(path, file(mode), 501)).toBe(
        `${path} has mode ${mode.toString(8)}, but it holds Slack tokens, so it must be 600. Run \`chmod 600 ${path}\` and start the bridge again.`,
      );
    }
    expect(credentialsFileProblem(path, file(0o600, 0), 501)).toBe(
      `${path} belongs to another user. Keep the Slack tokens in a file you own.`,
    );
    expect(
      credentialsFileProblem(path, { isFile: () => false, mode: 0o40700, uid: 501 }, 501),
    ).toBe(`${path} isn't a file. Keep the Slack tokens in a file only you can read.`);
  });

  test("is read from the data folder, and is optional", () => {
    const dataFolder = createTestFolder();
    expect(readCredentialsFile(dataFolder)).toEqual({});

    const file = join(dataFolder, "credentials.env");
    writeFileSync(file, "SLACK_BOT_TOKEN=xoxb-1\n", { mode: 0o600 });
    expect(readCredentialsFile(dataFolder)).toEqual({ SLACK_BOT_TOKEN: "xoxb-1" });

    chmodSync(file, 0o644);
    expect(() => readCredentialsFile(dataFolder)).toThrow(BridgeRefusedError);
  });

  test("refuses a folder in the file's place", () => {
    const dataFolder = createTestFolder();
    mkdirSync(join(dataFolder, "credentials.env"), { mode: 0o700 });

    expect(() => readCredentialsFile(dataFolder)).toThrow("isn't a file");
  });
});

describe("the Toy Box origin", () => {
  test("is Toy Box's own address unless TOY_BOX_URL names another", () => {
    expect(resolveToyBoxOrigin({}).href).toBe("http://127.0.0.1:3000/");
    expect(resolveToyBoxOrigin({ TOY_BOX_URL: "" }).href).toBe("http://127.0.0.1:3000/");
    expect(resolveToyBoxOrigin({ TOY_BOX_URL: "http://localhost:3100" }).href).toBe(
      "http://localhost:3100/",
    );
  });

  test("refuses a Toy Box anywhere but this Mac", () => {
    for (const url of ["https://127.0.0.1:3000", "http://10.0.0.2:3000", "toy-box"]) {
      const resolve = () => resolveToyBoxOrigin({ TOY_BOX_URL: url });
      expect(resolve).toThrow(BridgeRefusedError);
      expect(resolve).toThrow(
        `TOY_BOX_URL must be an http URL on this Mac, such as http://127.0.0.1:3000, but it's "${url}".`,
      );
    }
  });
});

describe("the wake timings", () => {
  test("are the policy's own unless TOY_BOX_SLACK_WAKE_TIMINGS sets some", () => {
    expect(resolveWakeTimings({})).toBe(defaultWakeTimings);
    expect(
      resolveWakeTimings({ TOY_BOX_SLACK_WAKE_TIMINGS: '{"debounce":100,"backoff":[1,2,3]}' }),
    ).toEqual({ ...defaultWakeTimings, debounce: 100, backoff: [1, 2, 3] });
  });

  test("refuses anything but a JSON object of known timings in whole milliseconds", () => {
    const refusals = {
      "{debounce: 100}": "expected object, received string",
      "[100]": "expected object, received array",
      '{"debunce":100}': 'Unrecognized key: "debunce"',
      '{"debounce":-1}': "expected number to be >=0",
      '{"debounce":1.5}': "expected int, received number",
      '{"backoff":[1,2]}': "expected array to have >=3 items",
    };
    for (const [value, problem] of Object.entries(refusals)) {
      const resolve = () => resolveWakeTimings({ TOY_BOX_SLACK_WAKE_TIMINGS: value });
      expect(resolve).toThrow(BridgeRefusedError);
      expect(resolve).toThrow(problem);
    }
  });
});
