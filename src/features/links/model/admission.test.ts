import { describe, expect, test } from "bun:test";
import { slackPerson as person } from "@slackapi/model/testFixtures";
import type { SlackPerson } from "@slackapi/model/users";
import { admissionProblem } from "./admission";

const home = { teamId: "T-home", enterpriseId: null };
const orgHome = { teamId: "T-home", enterpriseId: "E-org" };

describe("admitting a person", () => {
  test.each([
    ["a member of a sibling workspace in its org", { teamId: "T-b", enterpriseId: "E-org" }],
    ["an org member Slack names no workspace for", { teamId: null, enterpriseId: "E-org" }],
  ] as const)("%s is admitted", (_, changes) => {
    expect(admissionProblem("U-carol", person(changes), orgHome)).toBeNull();
  });

  test("their org-wide ID is theirs, and an answer about someone else or nobody isn't", () => {
    const carol = person({ enterpriseId: "E-org", enterpriseUserId: "W-carol" });
    expect(admissionProblem("W-carol", carol, orgHome)).toBeNull();
    expect(admissionProblem("U-other", carol, orgHome)).toBe("unverified");
    expect(admissionProblem("U-carol", null, orgHome)).toBe("user_not_found");
  });

  test.each([
    ["a bot", "bot", { isBot: true }, home],
    ["a workflow bot", "bot", { isWorkflowBot: true }, home],
    ["Slackbot", "bot", { id: "USLACKBOT" }, home],
    ["a deactivated account", "deactivated", { deleted: true }, home],
    ["a single-channel guest", "guest", { isUltraRestricted: true }, home],
    ["a guest without is_bot", "guest", { isBot: null, isRestricted: true }, home],
    ["someone from another workspace", "other_workspace", { teamId: "T-b" }, home],
    ["someone from another org", "other_org", { teamId: "T-b", enterpriseId: "E-c" }, orgHome],
    ["someone Slack names no workspace for", "unverified", { teamId: null }, home],
    ["someone without is_bot", "unverified", { isBot: null }, home],
    ["someone without is_restricted", "unverified", { isRestricted: null }, home],
    ["someone without is_ultra_restricted", "unverified", { isUltraRestricted: null }, home],
  ] as const)("%s is refused as %s", (_, problem, changes: Partial<SlackPerson>, installation) => {
    const candidate = person(changes);
    expect(admissionProblem(candidate.id, candidate, installation)).toBe(problem);
  });
});
