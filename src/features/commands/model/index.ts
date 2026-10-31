// The commands the bridge serves. The CLI offers each input field as a kebab-case option, or an
// argument when it's positional, and the bridge parses the text it read with the same schema, so a
// command can't mean one thing to the lead and another to the bridge. A list option can repeat. A
// path field is the one exception, since the bridge can't read the lead's files: the CLI reads
// each file it names and sends its bytes, as base64, in place of its path.

import { z } from "zod";
import { appNameSchema } from "@bridge/model/apps";
import { MAX_ALT_LENGTH, MAX_POST_IMAGES } from "@outbox/model/payload";
import type { CallerRole } from "./callers";

export type CommandSpec = {
  description: string;
  callers: readonly CallerRole[];
  /** A strict object whose fields parse the text the CLI read. */
  input: z.ZodObject;
  /** The fields the CLI takes as arguments instead, in order. A list takes every argument left. */
  positionals?: readonly string[];
  /** The list fields the CLI takes as paths, with the most bytes it reads of each file. */
  paths?: Readonly<Record<string, number>>;
};

/** A request as the lead writes it, such as r14, which the bridge reads as its number. */
export const requestReferenceSchema = z
  .string()
  .regex(/^r[1-9][0-9]{0,14}$/, "Write it as inbox shows it, such as r14")
  .transform((reference) => Number(reference.slice(1)))
  .describe("The request, such as r14");

/** A post as reply, publish or post names it, such as o31, which the bridge reads as its number. */
export const postReferenceSchema = z
  .string()
  .regex(/^o[1-9][0-9]{0,14}$/, "Write it as reply, publish or post showed it, such as o31")
  .transform((reference) => Number(reference.slice(1)))
  .describe("The post, such as o31");

/** A shared file as inbox or activity listed it, such as f12, which the bridge reads as its number. */
const fileReferenceSchema = z
  .string()
  .regex(/^f[1-9][0-9]{0,14}$/, "Write it as inbox or activity listed it, such as f12")
  .transform((reference) => Number(reference.slice(1)))
  .describe("The file, such as f12");

/** A Slack thread named by its request, such as r14, or by the lead's post it's under, such as o31. */
const threadReferenceSchema = z
  .string()
  .regex(/^[ro][1-9][0-9]{0,14}$/, "Name a request, such as r14, or one of your posts, such as o31")
  .transform((reference) =>
    reference.startsWith("r")
      ? { request: Number(reference.slice(1)) }
      : { post: Number(reference.slice(1)) },
  )
  .optional()
  .describe(
    "The thread to post in, by its request, such as r14, or your post it's under, such as o31",
  );

/** A thread as post's --thread takes it, such as r14 or o31. */
export function threadReference(thread: { request: number } | { post: number }): string {
  return "request" in thread ? `r${thread.request}` : `o${thread.post}`;
}

/** The CLI reads a post's text from stdin, so a lead can pass Markdown without quoting it. */
const postTextSchema = z
  .string()
  .refine((text) => text.trim() !== "", "Write the text on stdin, such as with a heredoc")
  .describe("The Markdown to post, read from stdin unless given here");

/** The most bytes of an image the lead posts, which the bridge rebuilds pixel by pixel. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** The images a post shows below its text, each with the alt text given in the same place. */
const imageFields = {
  image: z
    .array(
      z
        .base64()
        .transform((data): Uint8Array => Uint8Array.fromBase64(data))
        .refine((bytes) => bytes.length <= MAX_IMAGE_BYTES, "Give an image of at most 5 MiB"),
    )
    .max(MAX_POST_IMAGES, `Give at most ${MAX_POST_IMAGES}`)
    .optional()
    .describe(
      `A PNG you made to show below the text, by its path, up to ${MAX_POST_IMAGES}, each with an --alt`,
    ),
  alt: z
    .array(
      z
        .string()
        .trim()
        .min(1, "Say what the image shows")
        .max(MAX_ALT_LENGTH, `Keep it to ${MAX_ALT_LENGTH} characters`),
    )
    .optional()
    .describe(
      "What the --image in the same place shows, in a sentence, which Slack shows above it",
    ),
};

/** Whether a post gives as much alt text as images, which pair in order. */
function pairsImages({ image = [], alt = [] }: { image?: unknown[]; alt?: unknown[] }): boolean {
  return image.length === alt.length;
}
const unpairedImages = { path: ["alt"], message: "Give one for each --image" };

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

const slackChannelSchema = z
  .string()
  .regex(/^[CDG][A-Z0-9]{2,20}$/, "Give the channel's ID, such as C0123ABCD, not its name")
  .describe("The Slack channel's ID, such as C0123ABCD, which its details show at the bottom");

const memberIdSchema = z
  .string()
  .regex(/^[UW][A-Z0-9]{2,20}$/, "Give member IDs, such as U0123ABCD");

const slackUsersSchema = z
  .array(memberIdSchema)
  .min(1)
  .describe("Slack member IDs, such as U0123ABCD, which each one's profile shows");

/** Whom a post notifies, as one option whose member IDs are separated by commas. */
const mentionsSchema = z
  .string()
  .transform((ids) => ids.split(",").map((id) => id.trim()))
  .pipe(z.array(memberIdSchema))
  .optional()
  .describe(
    "People on the allowlist to notify, by the member IDs status shows, separated by commas, such as U0123ABCD,U0456EFGH",
  );

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
    input: z
      .object({ request: requestReferenceSchema, text: postTextSchema, ...imageFields })
      .strict()
      .refine(pairsImages, unpairedImages),
    positionals: ["request"],
    paths: { image: MAX_IMAGE_BYTES },
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
  file: {
    description:
      "Read a text file or image someone shared in Slack, as inbox or activity listed it",
    callers: ["lead"],
    input: z
      .object({
        file: fileReferenceSchema,
        page: z.coerce
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("The page of a text file to read, 1 unless set"),
      })
      .strict(),
    positionals: ["file"],
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
        ...imageFields,
      })
      .strict()
      .refine(pairsImages, unpairedImages),
    paths: { image: MAX_IMAGE_BYTES },
  },
  post: {
    description:
      "Post in the Slack channel, or in a thread there, when the owner or a routine asks you to",
    callers: ["lead"],
    input: z
      .object({
        thread: threadReferenceSchema,
        mention: mentionsSchema,
        text: postTextSchema,
        ...imageFields,
      })
      .strict()
      .refine(pairsImages, unpairedImages),
    paths: { image: MAX_IMAGE_BYTES },
  },
  retract: {
    description:
      "Delete one of your confirmed posts from Slack. A reply's request or a publication's run stays used",
    callers: ["lead"],
    input: z.object({ post: postReferenceSchema }).strict(),
    positionals: ["post"],
  },
  status: {
    description: "Show the link, Slack's connection, the requests and the wakes",
    callers: ["lead", "terminal"],
    input: z.object({}).strict(),
  },
  link: {
    description: "Link the Toy Box channel to a Slack channel, or change what the link does",
    callers: ["terminal"],
    input: z
      .object({
        slackChannel: slackChannelSchema,
        requests: z
          .enum(["mention", "all"])
          .optional()
          .describe("Which posts by an allowed person ask the lead: mention (the default) or all"),
        observe: z
          .enum(["requesters", "channel"])
          .optional()
          .describe("What the lead reads: requesters' threads (the default) or the whole channel"),
        app: appNameSchema
          .optional()
          .describe(
            "The app whose bot answers there, such as releases: the one it links through, or default",
          ),
      })
      .strict(),
  },
  allow: {
    description: "Let people make the lead act, by their Slack member IDs",
    callers: ["terminal"],
    input: z.object({ users: slackUsersSchema }).strict(),
    positionals: ["users"],
  },
  deny: {
    description: "Stop people making the lead act, and cancel what they asked",
    callers: ["lead", "terminal"],
    input: z.object({ users: slackUsersSchema }).strict(),
    positionals: ["users"],
  },
  pause: {
    description: "Stop answering and posting in Slack until the owner resumes",
    callers: ["lead", "terminal"],
    input: z.object({}).strict(),
  },
  resume: {
    description: "Answer and post in Slack again, once what paused or suspended the link is fixed",
    callers: ["terminal"],
    input: z.object({}).strict(),
  },
  unlink: {
    description: "Remove the link and delete what the bridge kept for it",
    callers: ["lead", "terminal"],
    input: z.object({}).strict(),
  },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof commands;

/** The option that sets `field`, such as --slack-channel for slackChannel. */
export function optionName(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Names options, such as "--a, --b, or --c". */
export function orList(options: readonly string[]): string {
  return new Intl.ListFormat("en", { type: "disjunction" }).format(options);
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
  return didntRun(name, [...new Set(problems)]);
}

/** Says `name` didn't run because of `problems`, and how to see what it takes. */
export function didntRun(name: string, problems: readonly string[]): string {
  return `\`${name}\` didn't run. ${problems.join(" ")} Run \`toy-box-slack ${name} --help\` to see what it takes.`;
}
