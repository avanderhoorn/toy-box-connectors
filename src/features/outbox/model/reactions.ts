// What the bot's reactions on a request's message tell whoever asked.
//
// 👀 means a lead was woken and hasn't read the request yet. 🏃 means the lead read it and owes
// an answer or a dismissal, though the bridge can't see whether the lead is typing right now. A
// request ends with neither once it's answered, and goes back to 👀 if it ends unanswered after the
// lead read it, so 🏃 never lingers on what nobody works on.
//
// Each standing names everything its message shows, so the newest one wins however many before it
// Slack missed, and the calls that bring a message to what it shows never depend on what it showed.

import type { SlackCall } from "@slackapi/server/botClient";
import { isSlackFault } from "./delivery";

/** Where a request stands for whoever asked. */
export type Standing = "woken" | "working" | "answered" | "released";

/** Everything a request's message shows: 👀, 🏃 or neither. */
export type Display = "eyes" | "runner" | "bare";

/** One call to Slack on the request's message. Slack names 🏃 `runner`. */
export type ReactionChange = {
  change: "add" | "remove";
  name: "eyes" | "runner";
};

/** What a request's message shows at a standing. */
export function displayOf(standing: Standing): Display {
  switch (standing) {
    case "woken":
    case "released":
      return "eyes";
    case "working":
      return "runner";
    case "answered":
      return "bare";
  }
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
