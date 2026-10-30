// A setup command answers with what it changed, in words the owner can check against Slack, and
// each refusal says what to do first.

import type { AdmissionProblem } from "@links/model/admission";
import type { ApprovalProblem, Audience } from "@links/model/audience";
import type { LinkStatus } from "./status";

const approvalProblems: Record<ApprovalProblem, string> = {
  channel_not_found: "Slack can't find it. If it's private, invite the bot first",
  not_a_channel: "It's a direct message, and only channels can be linked",
  channel_archived: "It's archived. Unarchive it first",
  bot_removed: "The bot isn't in it. Invite the bot first",
  channel_external: "It's shared with another organization, or a share is pending",
  channel_other_org: "It's shared across another Enterprise org",
  channel_other_workspace: "It's in a workspace other than the bot's",
  workspaces_unknown: "Slack didn't say which workspaces can read it",
};

const admissionProblems: Record<AdmissionProblem, string> = {
  user_not_found: "Slack doesn't know them",
  unverified: "Slack didn't say enough about them to tell",
  bot: "they're a bot",
  deactivated: "they're deactivated",
  guest: "they're a guest",
  other_org: "they're in another Enterprise org",
  other_workspace: "they're in another workspace",
};

/** Why the lead can't answer in `channel`, and what to do first. */
export function approvalRefusal(problem: ApprovalProblem, channel: string): string {
  return `The lead can't answer in ${channel}, so nothing changed. ${approvalProblems[problem]}.`;
}

/** Why `who` can't be allowed. */
export function admissionRefusal(who: string, problem: AdmissionProblem): string {
  return `Nobody was allowed, since only full members of the bot's workspace or its Enterprise org can be, and ${who} isn't: ${admissionProblems[problem]}.`;
}

/** Who can ask the lead to act from `channel` now that `allow` named them. */
export function presentAllowed(people: readonly string[], channel: string): string {
  const [person, ...others] = people;
  if (person !== undefined && others.length === 0) {
    return `${person} can ask the lead to act from ${channel} now.`;
  }
  const list = people.map((shown) => `- ${shown}`).join("\n");
  return `They can all ask the lead to act from ${channel} now:\n\n${list}`;
}

/** What the lead of `toyBox` does in `channel` once it's linked there, through `app` if it's named. */
export function presentLink(
  toyBox: string,
  channel: string,
  audience: Audience,
  { requestMode, observe }: Pick<LinkStatus, "requestMode" | "observe">,
  app: string | null = null,
): string {
  const workspaces = new Intl.ListFormat("en").format(audience.workspaces);
  const readers =
    audience.kind === "private"
      ? "only its members"
      : audience.orgShared
        ? `anyone in workspaces ${workspaces} of its Enterprise org`
        : "anyone in the bot's workspace";
  const asks =
    requestMode === "all" ? "posting at the top level or mentioning the bot" : "mentioning the bot";
  const reads =
    observe === "channel"
      ? `everything said in ${channel}`
      : "what allowed people say, and everyone's replies in request threads";
  const asBot = app ? ` as the ${app} app's bot` : "";
  return `The lead of ${toyBox} answers in ${channel} now${asBot}, for the people \`toy-box-slack allow\` names.

- Who reads the lead's answers: ${channel} is ${audience.kind}, so ${readers} can.
- What asks the lead: an allowed person ${asks}.
- What the lead reads: ${reads}.`;
}

/** A post the lead queued, as an answer to the owner names it. */
export type QueuedPost = {
  number: number;
  kind: "reply" | "publication";
  requestId: number | null;
  series: string | null;
};

/**
 * Which posts won't go out, since more people can read `channel` than when the lead wrote them, and
 * which requests, `returned`, the lead gets back to answer again.
 */
export function presentDropped(
  dropped: readonly QueuedPost[],
  returned: readonly number[],
  channel: string,
): string {
  const wrote = `More people can read ${channel} than when the lead wrote`;
  const back = returned.length
    ? `The lead gets ${new Intl.ListFormat("en").format(returned.map((id) => `r${id}`))} back to answer again.`
    : null;
  const [post, ...others] = dropped;
  if (post !== undefined && others.length === 0) {
    return [`${wrote} ${described(post)}, so it won't post.`, back].filter(Boolean).join(" ");
  }
  const list = dropped.map((queued) => `- ${described(queued)}`).join("\n");
  return [`${wrote} these, so they won't post:\n\n${list}`, back].filter(Boolean).join("\n\n");
}

function described({ number, kind, requestId, series }: QueuedPost): string {
  return kind === "reply"
    ? `o${number}, its answer to r${requestId}`
    : `o${number}, its ${series} publication`;
}
