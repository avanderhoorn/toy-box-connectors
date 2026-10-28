import { describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultWakeTimings } from "@wakes/model";
import { readCredentialsFile, resolveBridgeSettings, writeCredential } from "./environment";
import { BridgeRefusedError } from "./refusal";
import { createTestFolder } from "./testFixtures";

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

  test("come from the environment first and credentials.env next, where empty counts as unset", () => {
    expect(resolveBridgeSettings({}, file)).toEqual({
      toyBoxOrigin: new URL("http://127.0.0.1:3100"),
      botToken: "xoxb-file",
      appToken: "xapp-file",
      slackApiUrl: undefined,
      wakeTimings: defaultWakeTimings,
    });
    const env = {
      SLACK_BOT_TOKEN: "xoxb-env",
      SLACK_APP_TOKEN: "",
      TOY_BOX_URL: "http://[::1]:3000",
      SLACK_API_URL: "http://127.0.0.1:4100/api/",
      TOY_BOX_SLACK_WAKE_TIMINGS: '{"debounce":100,"backoff":[1,2,3]}',
    };
    expect(resolveBridgeSettings(env, file)).toEqual({
      toyBoxOrigin: new URL("http://[::1]:3000"),
      botToken: "xoxb-env",
      appToken: "xapp-file",
      slackApiUrl: "http://127.0.0.1:4100/api/",
      wakeTimings: { ...defaultWakeTimings, debounce: 100, backoff: [1, 2, 3] },
    });
    expect(resolveBridgeSettings({ TOY_BOX_URL: "" }, { SLACK_BOT_TOKEN: "" })).toMatchObject({
      toyBoxOrigin: new URL("http://127.0.0.1:3000"),
      botToken: null,
      appToken: null,
    });
  });

  test("refuse a Toy Box anywhere but this Mac", () => {
    for (const url of ["https://127.0.0.1:3000", "http://10.0.0.2:3000", "toy-box"]) {
      expect(refusalOf(() => resolveBridgeSettings({}, { TOY_BOX_URL: url }))).toBe(
        `TOY_BOX_URL must be an http URL on this Mac, such as http://127.0.0.1:3000, but it's "${url}".`,
      );
    }
  });
});

describe("credentials.env", () => {
  test("is optional, and holds NAME=value lines where export, quotes and comments are allowed", () => {
    const dataFolder = createTestFolder();
    expect(readCredentialsFile(dataFolder)).toEqual({});

    const text = [
      "# Slack tokens for the bridge",
      "",
      "SLACK_BOT_TOKEN=xoxb-1 # the bot",
      'export SLACK_APP_TOKEN = "xapp-2"\r',
      "  TOY_BOX_URL='http://127.0.0.1:3100/?a=b'  ",
    ].join("\n");
    writeFileSync(join(dataFolder, "credentials.env"), text, { mode: 0o600 });

    expect(readCredentialsFile(dataFolder)).toEqual({
      SLACK_BOT_TOKEN: "xoxb-1",
      SLACK_APP_TOKEN: "xapp-2",
      TOY_BOX_URL: "http://127.0.0.1:3100/?a=b",
    });
  });

  test("keeps its other lines when a setting is written, and stays at mode 600", () => {
    const dataFolder = createTestFolder();
    const path = join(dataFolder, "credentials.env");
    writeCredential(dataFolder, "OWNER_PASSPHRASE_HASH", "$argon2id$old");
    appendFileSync(path, "# the bot\nSLACK_BOT_TOKEN=xoxb-1\n");
    writeCredential(dataFolder, "OWNER_PASSPHRASE_HASH", "$argon2id$new");

    expect(readCredentialsFile(dataFolder)).toEqual({
      SLACK_BOT_TOKEN: "xoxb-1",
      OWNER_PASSPHRASE_HASH: "$argon2id$new",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("is refused when others could read or write it, or it sets anything else, without repeating a value", () => {
    const dataFolder = createTestFolder();
    const path = join(dataFolder, "credentials.env");
    writeFileSync(path, "SLACK_BOT_TOKEN=xoxb-secret\nSLACK_SIGNING_SECRET=secret\n", {
      mode: 0o600,
    });

    expect(refusalOf(() => readCredentialsFile(dataFolder))).toBe(
      `${path} may set only SLACK_BOT_TOKEN, SLACK_APP_TOKEN, TOY_BOX_URL and OWNER_PASSPHRASE_HASH.\n✖ Unrecognized key: "SLACK_SIGNING_SECRET"`,
    );
    for (const mode of [0o640, 0o604, 0o620, 0o602]) {
      chmodSync(path, mode);
      expect(refusalOf(() => readCredentialsFile(dataFolder))).toBe(
        `${path} has mode ${mode.toString(8)}, but it holds Slack tokens, so it must be 600. Run \`chmod 600 ${path}\` and start the bridge again.`,
      );
    }
  });
});
