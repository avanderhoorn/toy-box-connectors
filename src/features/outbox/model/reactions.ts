// What the bot's reactions on a request's message tell whoever asked.
//
// 👀 means a lead was woken and hasn't read the request yet. 🏃 means the lead read it and owes
// an answer or a dismissal, though the bridge can't see whether the lead is typing right now. A
// request ends with neither once it's answered, and goes back to 👀 if it ends unanswered after the
// lead read it, so 🏃 never lingers on what nobody works on.

/** Where a request stands for whoever asked. */
export type Standing = "woken" | "working" | "answered" | "released";

/** One call to Slack on the request's message. Slack names 🏃 `runner`. */
export type ReactionChange = {
  change: "add" | "remove";
  name: "eyes" | "runner";
};

/**
 * The calls that bring a message to a standing, in order. Every swap adds first, so the message
 * is never bare between its halves, and an answer takes off both, so it ends with neither even
 * when an earlier removal was lost.
 */
export function reactionChanges(standing: Standing): readonly ReactionChange[] {
  switch (standing) {
    case "woken":
      return [{ change: "add", name: "eyes" }];
    case "working":
      return [
        { change: "add", name: "runner" },
        { change: "remove", name: "eyes" },
      ];
    case "answered":
      return [
        { change: "remove", name: "eyes" },
        { change: "remove", name: "runner" },
      ];
    case "released":
      return [
        { change: "add", name: "eyes" },
        { change: "remove", name: "runner" },
      ];
  }
}
