import { describe, expect, test } from "bun:test";
import { slackPerson as person } from "@slackapi/model/testFixtures";
import { admissionProblem } from "./admission";

const home = { teamId: "T-home", enterpriseId: null };
const orgHome = { teamId: "T-home", enterpriseId: "E-org" };

describe("admitting a person", () => {
  test("a full member of the installation's workspace is admitted", () => {
    expect(admissionProblem("U-carol", person(), home)).toBeNull();
    expect(admissionProblem("U-carol", person(), orgHome)).toBeNull();
  });

  test("a member of a sibling workspace in the installation's org is admitted", () => {
    const sibling = person({ teamId: "T-sibling", enterpriseId: "E-org" });
    expect(admissionProblem("U-carol", sibling, orgHome)).toBeNull();
  });

  test("someone Slack doesn't know is refused", () => {
    expect(admissionProblem("U-carol", null, home)).toBe("user_not_found");
  });

  test("an answer about someone else is refused, while their org-wide ID counts as theirs", () => {
    expect(admissionProblem("U-other", person(), home)).toBe("unverified");
    expect(
      admissionProblem(
        "W-carol",
        person({ enterpriseId: "E-org", enterpriseUserId: "W-carol" }),
        orgHome,
      ),
    ).toBeNull();
  });

  test("bots, workflow bots and Slackbot are refused", () => {
    expect(admissionProblem("U-carol", person({ isBot: true }), home)).toBe("bot");
    expect(admissionProblem("U-carol", person({ isWorkflowBot: true }), home)).toBe("bot");
    expect(admissionProblem("USLACKBOT", person({ id: "USLACKBOT" }), home)).toBe("bot");
  });

  test("a deactivated account is refused", () => {
    expect(admissionProblem("U-carol", person({ deleted: true }), home)).toBe("deactivated");
  });

  test("multi-channel and single-channel guests are refused", () => {
    expect(admissionProblem("U-carol", person({ isRestricted: true }), home)).toBe("guest");
    expect(admissionProblem("U-carol", person({ isUltraRestricted: true }), home)).toBe("guest");
  });

  test("someone from another workspace is refused outside an org", () => {
    expect(admissionProblem("U-carol", person({ teamId: "T-other" }), home)).toBe(
      "other_workspace",
    );
    expect(
      admissionProblem("U-carol", person({ teamId: "T-other", enterpriseId: "E-org" }), home),
    ).toBe("other_workspace");
  });

  test("someone from another org is refused, whatever workspace they name", () => {
    expect(
      admissionProblem("U-carol", person({ teamId: "T-other", enterpriseId: "E-other" }), orgHome),
    ).toBe("other_org");
    expect(admissionProblem("U-carol", person({ teamId: "T-other" }), orgHome)).toBe("unverified");
  });

  test("an answer that leaves out the workspace or org admission needs is refused", () => {
    expect(admissionProblem("U-carol", person({ teamId: null }), home)).toBe("unverified");
    expect(admissionProblem("U-carol", person({ teamId: null }), orgHome)).toBe("unverified");
    expect(
      admissionProblem("U-carol", person({ teamId: null, enterpriseId: "E-org" }), orgHome),
    ).toBeNull();
  });

  test("an answer that leaves out whether they're a bot or a guest is refused", () => {
    for (const unknown of [{ isBot: null }, { isRestricted: null }, { isUltraRestricted: null }]) {
      expect(admissionProblem("U-carol", person(unknown), home)).toBe("unverified");
      expect(admissionProblem("U-carol", person(unknown), orgHome)).toBe("unverified");
    }
  });

  test("a definite problem comes before a flag Slack left out, so a recheck can act on it", () => {
    expect(admissionProblem("U-carol", person({ isBot: null, isRestricted: true }), home)).toBe(
      "guest",
    );
    expect(admissionProblem("U-carol", person({ isRestricted: null, isBot: true }), home)).toBe(
      "bot",
    );
    expect(admissionProblem("U-carol", person({ isBot: null, deleted: true }), home)).toBe(
      "deactivated",
    );
    expect(
      admissionProblem("U-carol", person({ isUltraRestricted: null, teamId: "T-other" }), home),
    ).toBe("other_workspace");
    expect(
      admissionProblem(
        "U-carol",
        person({ isBot: null, teamId: "T-other", enterpriseId: "E-other" }),
        orgHome,
      ),
    ).toBe("other_org");
  });

  test("the account checks come before membership, so a guest of the workspace is still a guest", () => {
    expect(
      admissionProblem("U-carol", person({ isBot: true, teamId: "T-other", deleted: true }), home),
    ).toBe("bot");
    expect(admissionProblem("U-carol", person({ deleted: true, isRestricted: true }), home)).toBe(
      "deactivated",
    );
  });
});
