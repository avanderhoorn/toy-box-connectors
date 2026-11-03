// What the bot's reactions on a request's message tell whoever asked.
//
// 👀 means a lead was woken and hasn't read the request yet. 🏃 means the lead read it and owes
// an answer or a dismissal, though the bridge can't see whether the lead is typing right now. A
// request ends with neither once it's answered, and goes back to 👀 if it ends unanswered after the
// lead read it, so 🏃 never lingers on what nobody works on.
//
// What a message shows follows from where its request stands, so whatever changes a request owes
// the display the change calls for, and a display names everything its message shows, so the newest
// one wins however many before it Slack missed.

import type { SlackCall } from "@slackapi/server/botClient";
import { isActive, wasRead, type Request } from "@requests/model/lifecycle";
import { isSlackFault } from "./delivery";

/** Everything a request's message shows: 👀, 🏃 or neither. */
export type Display = "eyes" | "runner" | "bare";

/** One call to Slack on the request's message. Slack names 🏃 `runner`. */
export type ReactionChange = {
  change: "add" | "remove";
  name: "eyes" | "runner";
};

/**
 * The display a change to a request owes its message, or null when what it shows stays right. The
 * lead's first read shows 🏃, an answer shows neither, and an end the lead read unanswered shows 👀.
 * One that ends before the lead read it keeps whatever a wake gave it.
 */
export function displayChange(
  before: Pick<Request, "state">,
  after: Pick<Request, "state">,
): Display | null {
  if (after.state === "answered") return "bare";
  if (wasRead(after)) return wasRead(before) ? null : "runner";
  return wasRead(before) && !isActive(after.state) ? "eyes" : null;
}

/**
 * The calls that bring a message to a display, in order. A swap adds first, so the message is never
 * bare between its halves, and a call for what the message already shows or lacks changes nothing.
 */
export function reactionChanges(display: Display): readonly ReactionChange[] {
  switch (display) {
    case "eyes":
      return [
        { change: "add", name: "eyes" },
        { change: "remove", name: "runner" },
      ];
    case "runner":
      return [
        { change: "add", name: "runner" },
        { change: "remove", name: "eyes" },
      ];
    case "bare":
      return [
        { change: "remove", name: "eyes" },
        { change: "remove", name: "runner" },
      ];
  }
}

/**
 * What Slack's answer to a reaction call leaves to do. A call Slack accepted or refused is done,
 * since a refusal such as `already_reacted`, `no_reaction` or `message_not_found` means the call
 * has nothing left to change. One Slack didn't answer, or failed on, may not have run, so the
 * display is tried again. One it held back, or turned away, waits for a later pass.
 */
export function judgeReaction(call: SlackCall<unknown>): "done" | "unanswered" | "held" {
  switch (call.kind) {
    case "ok":
      return "done";
    case "error":
      return isSlackFault(call.error) ? "unanswered" : "done";
    case "unknown":
      return "unanswered";
    case "rate_limited":
    case "auth_failed":
      return "held";
  }
}
