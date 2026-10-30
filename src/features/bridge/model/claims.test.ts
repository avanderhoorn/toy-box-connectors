import { describe, expect, test } from "bun:test";
import { recordedHolders } from "./claims";

describe("the Slack apps the apps' bridge.db files record", () => {
  test("are held by the first app in start order when two record the same one", () => {
    const holders = recordedHolders([
      { app: "default", slackAppId: null },
      { app: "ops", slackAppId: "A1" },
      { app: "releases", slackAppId: "A1" },
    ]);

    expect(holders).toEqual(new Map([["A1", "ops"]]));
  });
});
