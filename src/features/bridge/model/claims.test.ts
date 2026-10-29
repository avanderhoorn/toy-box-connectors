import { describe, expect, test } from "bun:test";
import { claimSlackApp, recordedHolders, type SlackAppHolders } from "./claims";

/** Claims each of `claims` in turn, an app and the Slack app it confirms, and returns each heldBy. */
function claimInTurn(holders: SlackAppHolders, claims: readonly (readonly [string, string])[]) {
  return claims.map(([app, slackAppId]) => {
    const claimed = claimSlackApp(holders, slackAppId, app);
    holders = claimed.holders;
    return claimed.heldBy;
  });
}

describe("the Slack apps the apps' bridge.db files record", () => {
  test("are each held by the app that records it", () => {
    const holders = recordedHolders([
      { app: "default", slackAppId: "A1" },
      { app: "releases", slackAppId: "A2" },
      { app: "triage", slackAppId: null },
    ]);

    expect(holders).toEqual(
      new Map([
        ["A1", "default"],
        ["A2", "releases"],
      ]),
    );
  });

  test("are held by the first app in start order when two record the same one", () => {
    const holders = recordedHolders([
      { app: "default", slackAppId: null },
      { app: "ops", slackAppId: "A1" },
      { app: "releases", slackAppId: "A1" },
    ]);

    expect(holders).toEqual(new Map([["A1", "ops"]]));
  });
});

describe("claiming a Slack app", () => {
  test("refuses an app that doesn't record a Slack app another one records", () => {
    const holders = recordedHolders([
      { app: "default", slackAppId: null },
      { app: "releases", slackAppId: "A1" },
    ]);

    expect(claimInTurn(holders, [["default", "A1"]])).toEqual(["releases"]);
  });

  test("gives a Slack app no bridge.db records to the first app Slack confirms it for", () => {
    const holders = recordedHolders([
      { app: "default", slackAppId: null },
      { app: "releases", slackAppId: null },
    ]);

    expect(
      claimInTurn(holders, [
        ["releases", "A1"],
        ["default", "A1"],
      ]),
    ).toEqual([null, "releases"]);
  });

  test("lets the app holding a Slack app claim it again, as each confirmation does", () => {
    const holders = recordedHolders([{ app: "default", slackAppId: "A1" }]);

    expect(
      claimInTurn(holders, [
        ["default", "A1"],
        ["releases", "A2"],
        ["releases", "A2"],
        ["default", "A1"],
      ]),
    ).toEqual([null, null, null, null]);
  });

  test("changes nothing it was given", () => {
    const holders = recordedHolders([{ app: "default", slackAppId: "A1" }]);

    claimSlackApp(holders, "A2", "releases");

    expect(holders).toEqual(new Map([["A1", "default"]]));
  });
});
