// The commands the bridge serves. The CLI offers each input field as a kebab-case option, or an
// argument when it's positional, and the bridge parses the text it read with the same schema, so a
// command can't mean one thing to the lead and another to the bridge.

import { z } from "zod";
import type { CallerRole } from "./callers";

export type CommandSpec = {
  description: string;
  callers: readonly CallerRole[];
  /** A strict object whose fields parse the text the CLI read. */
  input: z.ZodObject;
  /** The fields the CLI takes as arguments instead, in order. */
  positionals?: readonly string[];
};

/** A request as the lead writes it, such as r14, which the bridge reads as its number. */
export const requestReferenceSchema = z
  .string()
  .regex(/^r[1-9][0-9]{0,14}$/, "Write it as inbox shows it, such as r14")
  .transform((reference) => Number(reference.slice(1)))
  .describe("The request, such as r14");

/** A post as reply or publish names it, such as o31, which the bridge reads as its number. */
export const postReferenceSchema = z
  .string()
  .regex(/^o[1-9][0-9]{0,14}$/, "Write it as reply or publish showed it, such as o31")
  .transform((reference) => Number(reference.slice(1)))
  .describe("The post, such as o31");

/** The CLI reads a post's text from stdin, so a lead can pass Markdown without quoting it. */
const postTextSchema = z
  .string()
  .refine((text) => text.trim() !== "", "Write the text on stdin, such as with a heredoc")
  .describe("The Markdown to post, read from stdin unless given here");

/** At most how many of `items` a command shows, `fallback` unless set. */
function limitSchema(most: number, fallback: number, items: string) {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(most)
    .default(fallback)
    .describe(`The most ${items} to show, ${fallback} unless set`);
}

export const commands = {
  inbox: {
    description: "Read the requests waiting on you, with their threads so far, and mark them seen",
    callers: ["lead"],
    input: z.object({ limit: limitSchema(50, 10, "requests") }).strict(),
  },
  dismiss: {
    description: "End a request that needs no answer",
    callers: ["lead"],
    input: z
      .object({
        request: requestReferenceSchema,
        reason: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("Why it needs no answer, which the request keeps"),
      })
      .strict(),
    positionals: ["request"],
  },
  reply: {
    description: "Answer a request in its Slack thread, once",
    callers: ["lead"],
    input: z.object({ request: requestReferenceSchema, text: postTextSchema }).strict(),
    positionals: ["request"],
  },
  activity: {
    description: "Read what changed in the Slack channel since you last marked it read",
    callers: ["lead"],
    input: z.object({ limit: limitSchema(500, 200, "messages") }).strict(),
  },
  "mark-read": {
    description: "Mark activity read through the change it named, so the next starts after it",
    callers: ["lead"],
    input: z
      .object({
        through: z.coerce.number().int().min(1).describe("The change activity named, such as 57"),
      })
      .strict(),
  },
  publish: {
    description:
      "Post in the Slack channel once for the latest scheduled run of the routine whose prompt runs this command",
    callers: ["lead"],
    input: z
      .object({
        series: z
          .string()
          .describe("What the posts are, as the routine's prompt names it, such as release-notes"),
        text: postTextSchema,
      })
      .strict(),
  },
  retract: {
    description: "Delete one of your confirmed posts from Slack. Its request or run stays used",
    callers: ["lead"],
    input: z.object({ post: postReferenceSchema }).strict(),
    positionals: ["post"],
  },
  status: {
    description: "Show the link, Slack's connection, the requests and the wakes",
    callers: ["lead", "terminal"],
    input: z.object({}).strict(),
  },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof commands;

/** The option that sets `field`, such as --slack-channel for slackChannel. */
export function optionName(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** What's wrong with `input` for `name`, naming each option or argument the way the CLI does. */
export function inputProblem(
  name: string,
  spec: CommandSpec,
  input: Record<string, unknown>,
  error: z.ZodError,
): string {
  const problems = error.issues.map(({ path, message }) => {
    const field = String(path[0] ?? "");
    const shown = spec.positionals?.includes(field)
      ? `<${optionName(field)}>`
      : `--${optionName(field)}`;
    return `${shown}: ${input[field] === undefined ? "Missing" : message}.`;
  });
  return `\`${name}\` didn't run. ${problems.join(" ")} Run \`toy-box-slack ${name} --help\` to see what it takes.`;
}
