// The hold command.
//
// The lead holds a request it can't answer until the owner decides, such as a question from someone
// else that it flagged to the owner. A held request gets no reminders. The owner's next message in
// the Toy Box channel ends the hold, as does any change to the request in Slack, and a held request
// still expires.

import { z } from "zod";
import { commandContract, type PresentContext } from "./contract";
import { reasonSchema, requestIdSchema, requestReferenceSchema } from "./requests";
import { duration } from "./wording";

export const holdResultSchema = z
  .object({
    request: requestIdSchema,
    attention: z
      .enum(["updated", "reply_failed"])
      .nullable()
      .describe("Why the lead must read it again though it's held, or null when it needn't"),
    expiresAt: z.number().int().describe("When it expires unless it's answered"),
  })
  .strict();
export type HoldResult = z.output<typeof holdResultSchema>;

export const holdContract = commandContract({
  description: "Stop reminders about a request while you wait for the owner to decide",
  roles: ["lead"],
  scope: "channel",
  input: z
    .object({
      request: requestReferenceSchema,
      reason: reasonSchema.describe("What you're waiting for the owner to decide"),
    })
    .strict(),
  positionals: ["request"],
  result: holdResultSchema,
  present: presentHold,
});

/** What holding changed, and what the lead still owes the request. */
export function presentHold(
  { request, attention, expiresAt }: HoldResult,
  { at }: PresentContext,
): string {
  const name = `r${request}`;
  const lines = [
    `Held ${name}, so you won't be reminded about it. The hold ends when the owner next posts in this Toy Box channel or ${name} changes in Slack. It still expires in ${duration(expiresAt - at)}.`,
  ];
  if (attention === "updated") {
    lines.push(
      `${name} changed since you last read it. Run \`toy-box-slack thread ${name}\` to read it.`,
    );
  }
  if (attention === "reply_failed") {
    lines.push(
      `Your last reply to ${name} didn't post, so answer it again once the owner decides.`,
    );
  }
  return lines.join("\n\n");
}
