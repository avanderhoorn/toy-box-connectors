// Activity shows what changed in Slack since the lead last marked it read, thread by thread with
// each thread's link for a digest to cite, and ends with the mark-read that covers what it showed.

import { presentMessage, type InboxMessage } from "./inbox";
import { ago, count } from "./wording";

export type ActivityThread = {
  /** When its first message was posted. */
  startedAt: number;
  permalink: string | null;
  messages: InboxMessage[];
};

export type Activity = {
  /** The Slack channel, as #name. */
  channel: string;
  threads: ActivityThread[];
  /** The last change shown, which mark-read takes, or null when there's nothing new to read. */
  through: number | null;
  /** How many more changed messages wait after these. */
  more: number;
};

/** Activity as Markdown, ending with the mark-read that moves past it. */
export function presentActivity({ channel, threads, through, more }: Activity, at: number): string {
  if (through === null) return `Nothing new to read in ${channel} since you last marked it read.`;
  const sections = [`Here's what changed in ${channel} since you last marked it read.`];
  for (const { startedAt, permalink, messages } of threads) {
    const heading = `### Thread started ${ago(at - startedAt)}${permalink ? `\n${permalink}` : ""}`;
    sections.push([heading, ...messages.map(presentMessage)].join("\n\n"));
  }
  const next = more > 0 ? ` Then run activity again for ${count(more, "more message")}.` : "";
  sections.push(
    `Once you've read these, run \`toy-box-slack mark-read --through ${through}\`.${next}`,
  );
  return sections.join("\n\n");
}
