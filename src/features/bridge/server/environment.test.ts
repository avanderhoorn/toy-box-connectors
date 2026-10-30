import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultWakeTimings } from "@wakes/model";
import { readCredentialsFile, resolveBridgeSettings } from "./environment";
import { createTestFolder, refusalOf } from "./testFixtures";

describe("the bridge's settings", () => {
  const file = { TOY_BOX_URL: "http://127.0.0.1:3100" };

  test("come from the environment first and credentials.env next, where empty counts as unset", () => {
    expect(resolveBridgeSettings({}, file)).toEqual({
      toyBoxOrigin: new URL("http://127.0.0.1:3100"),
      slackApiUrl: undefined,
      wakeTimings: defaultWakeTimings,
    });
    const env = {
      TOY_BOX_URL: "http://[::1]:3000",
      SLACK_API_URL: "http://127.0.0.1:4100/api/",
      TOY_BOX_SLACK_WAKE_TIMINGS: '{"debounce":100,"backoff":[1,2,3]}',
    };
    expect(resolveBridgeSettings(env, file)).toEqual({
      toyBoxOrigin: new URL("http://[::1]:3000"),
      slackApiUrl: "http://127.0.0.1:4100/api/",
      wakeTimings: { ...defaultWakeTimings, debounce: 100, backoff: [1, 2, 3] },
    });
    expect(resolveBridgeSettings({ TOY_BOX_URL: "" }, { TOY_BOX_URL: "" })).toMatchObject({
      toyBoxOrigin: new URL("http://127.0.0.1:3000"),
    });
  });
});

describe("credentials.env", () => {
  test("is refused when others could read or write it, or it sets anything else, without repeating a value", () => {
    const dataFolder = createTestFolder();
    const path = join(dataFolder, "credentials.env");
    writeFileSync(path, "SLACK_BOT_TOKEN=xoxb-secret\nSLACK_SIGNING_SECRET=secret\n", {
      mode: 0o600,
    });

    expect(refusalOf(() => readCredentialsFile(dataFolder))).toBe(
      `${path} may set only SLACK_BOT_TOKEN, SLACK_APP_TOKEN and TOY_BOX_URL.\n✖ Unrecognized key: "SLACK_SIGNING_SECRET"`,
    );
    for (const mode of [0o640, 0o604, 0o620, 0o602]) {
      chmodSync(path, mode);
      expect(refusalOf(() => readCredentialsFile(dataFolder))).toBe(
        `${path} has mode ${mode.toString(8)}, but it holds Slack tokens, so it must be 600. Run \`chmod 600 ${path}\` and start the bridge again.`,
      );
    }
  });
});
