import { describe, expect, test } from "bun:test";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { publishCommand, REQUESTS_COMMAND, routineState } from "./index";
import {
  RELEASE_NOTES_SERIES,
  releaseNotesSchedules,
  routineTemplateNames,
  routineTemplates,
  type RoutineTemplateName,
} from "./routines";

// What set_routine accepts, as in the toy-box repo's
// src/features/channels/model/index.ts#channelRoutineInputSchema and src/shared/cron.ts#cronSchema.
const toyBoxRoutineSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    schedule: z
      .string()
      .trim()
      .min(1)
      .refine((cron) => {
        try {
          CronExpressionParser.parse(cron);
          return true;
        } catch {
          return false;
        }
      }, "Invalid cron definition")
      .refine((schedule) => /^\d+(\s+\S+){4}$/.test(schedule), "Routines run at most hourly"),
    prompt: z.string().trim().min(1).max(2_000),
  })
  .strict();

describe("routine templates", () => {
  test("offers the requests routine and the opt-in digest and release notes", () => {
    expect(routineTemplateNames.map((name) => [name, routineTemplates[name].title])).toEqual([
      ["requests", "Slack requests"],
      ["digest", "Slack digest"],
      ["release-notes", "Release notes"],
    ]);
  });

  test("each registers in Toy Box exactly as it is", () => {
    for (const { title, schedule, prompt } of Object.values(routineTemplates)) {
      const registered = { title, schedule, prompt };
      expect(toyBoxRoutineSchema.parse(registered)).toEqual(registered);
    }
  });

  test("a daily release notes schedule registers too", () => {
    const { title, prompt } = routineTemplates["release-notes"];
    const registered = { title, schedule: releaseNotesSchedules.day, prompt };
    expect(toyBoxRoutineSchema.parse(registered)).toEqual(registered);
  });

  test("each prompt is one paragraph, since Toy Box injects it as a JSON string", () => {
    for (const { prompt } of Object.values(routineTemplates)) expect(prompt).not.toMatch(/\p{Cc}/u);
  });

  test("no prompt names a Slack channel, so one registered before its link still fits", () => {
    for (const { prompt } of Object.values(routineTemplates)) expect(prompt).not.toContain("#");
  });

  test("each prompt runs the commands its routine needs", () => {
    const commands: Record<RoutineTemplateName, string[]> = {
      requests: [
        "run `toy-box-slack inbox`",
        "`toy-box-slack reply <id> --revision <n>`",
        "`reply <id> --revision <n> --progress`",
        "send_channel_message and request: true",
        "`toy-box-slack hold <id> --reason <why>`",
      ],
      digest: ["Run `toy-box-slack activity`", "`toy-box-slack mark-read --through <seq>`"],
      "release-notes": [
        "Run `toy-box-slack publications --series release-notes`",
        '`toy-box-slack publish --series release-notes --skip --reason "<why>"`',
        "pipe the notes to `toy-box-slack publish --series release-notes`",
      ],
    };
    for (const name of routineTemplateNames) {
      for (const command of commands[name])
        expect(routineTemplates[name].prompt).toContain(command);
    }
  });

  test("each prompt ends by restoring the waiting status its run cleared", () => {
    for (const { prompt } of Object.values(routineTemplates)) {
      expect(prompt).toEndWith(
        "When you finish, if the output said what you were waiting for before this turn and that's still true, call finish_agent_turn the way it shows.",
      );
    }
  });

  test("each routine the bridge checks runs the command it checks for", () => {
    expect(routineState(routineTemplates.requests, REQUESTS_COMMAND)).toBe("present");
    expect(
      routineState(routineTemplates["release-notes"], publishCommand(RELEASE_NOTES_SERIES)),
    ).toBe("present");
  });
});
