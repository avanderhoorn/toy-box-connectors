import { describe, expect, test } from "bun:test";
import { routineTemplateNames, routineTemplates } from "@toybox/model/routines";
import { presentRoutines, routinesContract, type RoutinesResult } from "./routines";

type Routine = RoutinesResult["routines"][number];

const [requests, digest, releaseNotes] = routineTemplateNames.map((name): Routine => ({
  template: name,
  ...routineTemplates[name],
  registered: null,
})) as [Routine, Routine, Routine];

const HEADER =
  "Register a routine with set_routine, using the title, schedule and prompt shown for it, and change a schedule only if the owner asks.";

/** The step that ends the routine's section. */
function nextStep(routine: Routine, linked = true): string {
  return presentRoutines({ linked, routines: [routine] })
    .split("\n\n")
    .at(-1)!;
}

describe("the routines command", () => {
  test("takes only a template it has, and no Slack channel", () => {
    const input = routinesContract.input;
    expect(input.parse({})).toEqual({});
    expect(input.parse({ template: "release-notes" })).toEqual({ template: "release-notes" });
    expect(input.safeParse({ template: "standup" }).success).toBe(false);
    expect(input.safeParse({ slackChannel: "C0RELEASE" }).success).toBe(false);
  });
});

describe("presenting routines", () => {
  test("shows a routine's title, schedule and prompt to copy, then how to give the bridge its ID", () => {
    expect(presentRoutines({ linked: false, routines: [requests] })).toBe(
      [
        HEADER,
        "## Slack requests",
        "Every link needs it. The bridge runs it whenever requests need you, so its schedule is only a safety net.",
        "Title `Slack requests`, schedule `0 9 * * 1-5`, prompt:",
        `\`\`\`\n${requests.prompt}\n\`\`\``,
        "Then have the owner link the channel with `toy-box-slack link --slack-channel <id> --routine <routineId>`, passing the Slack channel's ID and the routineId set_routine returned.",
      ].join("\n\n"),
    );
  });

  test("shows every routine in order, the opt-in ones only for the owner", () => {
    const shown = presentRoutines({ linked: true, routines: [requests, digest, releaseNotes] });
    expect(shown.split("\n").filter((line) => line.startsWith("## "))).toEqual([
      "## Slack requests",
      "## Slack digest",
      "## Release notes",
    ]);
    expect(shown).toContain(
      "## Slack digest\n\nRegister it only if the owner wants Slack activity summarized here. Unless the link observes the whole channel with `--observe channel`, it sees only what allowlisted people post and request threads.",
    );
    expect(shown).toContain(
      "## Release notes\n\nRegister it only if the owner wants release notes published in Slack.",
    );
  });

  test("the digest needs nothing from the bridge", () => {
    expect(nextStep(digest)).toBe("The bridge doesn't need its ID.");
    expect(nextStep(digest, false)).toBe("The bridge doesn't need its ID.");
  });

  test("release notes go to the link once there is one, weekly unless the owner wants them daily", () => {
    const daily = "For daily notes, schedule it `0 16 * * 1-5` and pass `--period day`.";
    expect(nextStep(releaseNotes, false)).toBe(
      `Once the channel is linked, run \`toy-box-slack routine --publish <routineId> --series release-notes --period week\` with the routineId set_routine returned. ${daily}`,
    );
    expect(nextStep(releaseNotes)).toBe(
      `Then run \`toy-box-slack routine --publish <routineId> --series release-notes --period week\` with the routineId set_routine returned. ${daily}`,
    );
  });

  test("a routine the link has can be updated in place or replaced", () => {
    const present = { routineId: "routine-requests", period: null, state: "present" } as const;
    expect(nextStep({ ...requests, registered: present })).toBe(
      "The link uses routine routine-requests. To update it in place, pass routineId routine-requests to set_routine with this prompt, keeping its title and schedule. To replace it, register this one, then run `toy-box-slack routine --requests <routineId>` with the routineId set_routine returned.",
    );
    const daily = { routineId: "routine-notes", period: "day", state: "present" } as const;
    expect(nextStep({ ...releaseNotes, registered: daily })).toBe(
      "The link uses routine routine-notes. To update it in place, pass routineId routine-notes to set_routine with this prompt, keeping its title and schedule. To replace it, register this one, then run `toy-box-slack routine --publish <routineId> --series release-notes --period day` with the routineId set_routine returned.",
    );
  });

  test("a drifted routine says which command its prompt lost", () => {
    const requestsDrifted = {
      routineId: "routine-requests",
      period: null,
      state: "drifted",
    } as const;
    expect(nextStep({ ...requests, registered: requestsDrifted })).toStartWith(
      "The link uses routine routine-requests, but its prompt no longer runs `toy-box-slack inbox`. To update it in place, pass routineId routine-requests to set_routine",
    );
    const notesDrifted = { routineId: "routine-notes", period: "week", state: "drifted" } as const;
    expect(nextStep({ ...releaseNotes, registered: notesDrifted })).toStartWith(
      "The link uses routine routine-notes, but its prompt no longer runs `toy-box-slack publish --series release-notes`. To update it in place,",
    );
  });

  test("a deleted routine can only be replaced, keeping its series' period", () => {
    const deleted = { routineId: "routine-requests", period: null, state: "missing" } as const;
    expect(nextStep({ ...requests, registered: deleted })).toBe(
      "The link's routine routine-requests was deleted, so register this one, then run `toy-box-slack routine --requests <routineId>` with the routineId set_routine returned.",
    );
    const weekly = { routineId: "routine-notes", period: "week", state: "missing" } as const;
    expect(nextStep({ ...releaseNotes, registered: weekly })).toBe(
      "The link's routine routine-notes was deleted, so register this one, then run `toy-box-slack routine --publish <routineId> --series release-notes --period week` with the routineId set_routine returned.",
    );
  });
});
