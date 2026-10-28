import { describe, expect, test } from "bun:test";
import { slackPerson as person } from "@slackapi/model/testFixtures";
import type { SlackPerson } from "@slackapi/model/users";
import { admissionProblem } from "./admission";

const home = { teamId: "T-home", enterpriseId: null };
const orgHome = { teamId: "T-home", enterpriseId: "E-org" };
const otherOrg = { teamId: "T-other", enterpriseId: "E-other" };

describe("admitting a person", () => {
  test.each([
    ["a full member of the installation's workspace", person(), home],
    [
      "a member of a sibling workspace in its org",
      person({ teamId: "T-sibling", enterpriseId: "E-org" }),
      orgHome,
    ],
    [
      "a member Slack names the org but not the workspace for",
      person({ teamId: null, enterpriseId: "E-org" }),
      orgHome,
    ],
  ] as const)("%s is admitted", (_, candidate, installation) => {
    expect(admissionProblem(candidate.id, candidate, installation)).toBeNull();
  });

  test("their org-wide ID counts as theirs, while an answer about someone else doesn't", () => {
    const carol = person({ enterpriseId: "E-org", enterpriseUserId: "W-carol" });
    expect(admissionProblem("W-carol", carol, orgHome)).toBeNull();
    expect(admissionProblem("U-other", carol, orgHome)).toBe("unverified");
  });

  test.each([
    ["someone Slack doesn't know", "user_not_found", null, home],
    ["a bot", "bot", person({ isBot: true }), home],
    ["a workflow bot", "bot", person({ isWorkflowBot: true }), home],
    ["Slackbot", "bot", person({ id: "USLACKBOT" }), home],
    ["a deactivated account", "deactivated", person({ deleted: true }), home],
    ["a multi-channel guest", "guest", person({ isRestricted: true }), home],
    ["a single-channel guest", "guest", person({ isUltraRestricted: true }), home],
    ["someone from another workspace", "other_workspace", person({ teamId: "T-other" }), home],
    ["someone from another org", "other_org", person(otherOrg), orgHome],
    ["someone Slack names no workspace for", "unverified", person({ teamId: null }), home],
    ["someone Slack doesn't say is a bot or not", "unverified", person({ isBot: null }), home],
    [
      "someone Slack doesn't say is a guest or not",
      "unverified",
      person({ isRestricted: null }),
      orgHome,
    ],
    // A definite problem comes first, so a recheck that removes people only for one still does.
    [
      "a guest Slack doesn't say is a bot or not",
      "guest",
      person({ isBot: null, isRestricted: true }),
      home,
    ],
    [
      "someone from another org Slack doesn't say is a bot or not",
      "other_org",
      person({ ...otherOrg, isBot: null }),
      orgHome,
    ],
  ] as const)("%s is refused as %s", (_, problem, candidate: SlackPerson | null, installation) => {
    expect(admissionProblem(candidate?.id ?? "U-carol", candidate, installation)).toBe(problem);
  });
});
