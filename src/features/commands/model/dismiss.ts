// The dismiss command.
//
// The lead dismisses a request that needs no answer, such as a duplicate or a thank-you, quoting
// the revision it read, so it never closes a request over text that changed since. Nothing posts in
// the request's thread, and anything the lead queued for it there won't post either.

import { z } from "zod";
import { commandContract } from "./contract";
import { reasonSchema, requestIdSchema, requestReferenceSchema, revisionSchema } from "./requests";

export const dismissResultSchema = z.object({ request: requestIdSchema }).strict();
export type DismissResult = z.output<typeof dismissResultSchema>;

export const dismissContract = commandContract({
  description: "Close a request that needs no answer, without replying in Slack",
  roles: ["lead"],
  scope: "channel",
  input: z
    .object({
      request: requestReferenceSchema,
      revision: revisionSchema,
      reason: reasonSchema.describe("Why it needs no answer"),
    })
    .strict(),
  positionals: ["request"],
  result: dismissResultSchema,
  present: presentDismiss,
});

export function presentDismiss({ request }: DismissResult): string {
  return `Dismissed r${request} without replying in Slack.`;
}
