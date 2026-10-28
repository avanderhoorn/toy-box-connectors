import {
  allowlistUser,
  APPROVE_ACTION_ID,
  REJECT_ACTION_ID,
  type Approval,
  type Json,
  type PatchEntry,
  type ReadSetLink,
  type StaleReason,
} from "./approvals";
import type { Audience } from "./audience";
import { suspensions } from "./status";

// Approval cards.
//
// The bridge posts a card for each proposal in the channel it concerns and updates it as the
// approval moves, rendering it from the approval each time. A card mentions only the owner, shows
// what the patch changes and the read-set it's decided against, and carries Approve and Reject
// only while it's pending. Only this renderer writes Slack markup into a card. Channels are
// Slack's own references, so Slack names them and hides a private one from anyone outside it.
// Other people show by the name the bridge stored, flattened and escaped, so allowing someone
// doesn't ping them and nothing a person or the lead chose can format, link or mention. Every
// mrkdwn object is verbatim, so Slack adds no links or mentions of its own.

/** A mrkdwn text object Slack shows as written. */
export type CardText = { type: "mrkdwn"; text: string; verbatim: true };

export type CardButton = {
  type: "button";
  action_id: typeof APPROVE_ACTION_ID | typeof REJECT_ACTION_ID;
  text: { type: "plain_text"; text: string };
  /** The approval's ID, the only thing a click carries. */
  value: string;
  style?: "primary";
};

export type CardBlock =
  | { type: "section"; text: CardText }
  | { type: "context"; elements: CardText[] }
  | { type: "actions"; elements: CardButton[] };

/** A card as chat.postMessage and chat.update take it, besides its channel and ts. */
export type CardMessage = {
  /** What a notification shows, which mentions the owner. */
  text: string;
  blocks: CardBlock[];
  parse: "none";
  unfurl_links: false;
  unfurl_media: false;
};

/** The names the bridge stored for the people a card shows, null for someone it can't name. */
export type CardNames = Readonly<Record<string, string | null>>;

/** Why an approval no longer applies, as a clause that reads after "because". */
export const staleReasons: Record<StaleReason, string> = {
  owner_changed: "the owner changed",
  link_changed: "the link changed",
  audience_changed: "who can read one of its channels changed",
  setting_changed: "a setting it changes was changed another way",
  channel_not_found: "Slack can't find one of its channels",
  not_a_channel: "it names a direct message, not a channel",
  channel_archived: "one of its channels was archived",
  bot_not_member: "the bot isn't in one of its channels",
  channel_external: "one of its channels is shared with another organization",
  channel_other_org: "one of its channels is shared across another Enterprise org",
  channel_other_workspace: "one of its channels is in another workspace",
  workspaces_unknown: "Slack didn't say which workspaces one of its channels is in",
  channel_made_public: "one of its channels was made public",
  workspace_joined: "another workspace can read one of its channels",
  owner_not_member: "the owner isn't in one of its channels",
  toybox_channel_deleted: "its Toy Box channel was deleted",
  provider: "the Toy Box lead doesn't run on Copilot",
  routine_missing: "the lead's requests routine is gone",
  already_linked: "another link uses the channel or the Toy Box channel",
  user_not_found: "Slack doesn't know the person it names",
  unverified: "Slack couldn't confirm who the person it names is",
  bot: "the person it names is a bot",
  deactivated: "the person it names was deactivated",
  guest: "the person it names is a guest",
  other_org: "the person it names is in another Enterprise org",
  other_workspace: "the person it names is in another workspace",
  other_id: "it names someone by an ID other than the one Slack gives them",
  reversed: "a later change undid it",
  not_verified: "the bridge couldn't check it with Slack and Toy Box in time",
};

/** The most characters a section's text can hold. */
export const SECTION_LIMIT = 3000;

/** How much of a stored name or label a card shows, in UTF-16 code units. */
export const NAME_LIMIT = 80;
export const LABEL_LIMIT = 40;

/** The people a card shows by name: everyone whose access it changes, and any new owner. */
export function cardPeople(approval: Pick<Approval, "patch">): string[] {
  const owner = approval.patch.find((entry) => entry.field === "owner_user_id");
  const people = allowlist(approval).map((entry) => entry.userId);
  if (typeof owner?.after === "string") people.push(owner.after);
  return [...new Set(people)];
}

/** An approval's card as the approval is now. */
export function renderCard(approval: Approval, names: CardNames): CardMessage {
  const lead = headline(approval, names);
  const blocks: CardBlock[] = [section(lead)];
  blocks.push(...packLines(details(approval, names).map((line) => `• ${line}`)).map(section));
  if (approval.state === "pending") {
    blocks.push(context(caution(approval)));
    blocks.push({ type: "actions", elements: buttons(approval.id) });
  }
  blocks.push(context(`a${approval.number} · ${stateLine(approval)}`));
  return { text: lead, blocks, parse: "none", unfurl_links: false, unfurl_media: false };
}

function headline(approval: Approval, names: CardNames): string {
  const owner = mention(approval.readSet.ownerUserId);
  const channel = channelReference(approval.readSet.monitored.channelId);
  switch (approval.action) {
    case "link":
      return `${owner} Approve linking ${channel} to your Toy Box lead?`;
    case "allow":
      return allowed(approval).length === 0
        ? `${owner} Approve changing who can ask your Toy Box lead for help in ${channel}?`
        : `${owner} Approve letting ${allowedNames(approval, names)} ask your Toy Box lead for help in ${channel}?`;
    case "set":
      return `${owner} Approve changing how your Toy Box lead works in ${channel}?`;
    case "resume":
      return `${owner} Approve resuming your Toy Box lead in ${channel}?`;
    case "owner": {
      const next = approval.patch.find((entry) => entry.field === "owner_user_id")?.after;
      return `${owner} Approve handing ownership of the Slack bridge to ${typeof next === "string" ? name(next, names) : "someone else"}?`;
    }
  }
}

/** What the patch changes, then what the card is decided against. */
function details(approval: Approval, names: CardNames): string[] {
  const { readSet } = approval;
  const lines: string[] = [];
  const entry = (field: PatchEntry["field"]) => approval.patch.find((each) => each.field === field);
  const before = (field: PatchEntry["field"]) => readSet.before[field];

  const watched = entry("slack_channel_id");
  if (typeof watched?.after === "string") lines.push(`Watches ${channelReference(watched.after)}`);
  const publish = entry("publish_channel_id");
  if (typeof publish?.after === "string" && publish.after !== watched?.after) {
    lines.push(`Publishes to ${change(before("publish_channel_id"), publish.after, channelValue)}`);
  }
  const requests = entry("request_mode");
  if (requests)
    lines.push(`Requests: ${change(before("request_mode"), requests.after, requestMode)}`);
  const observe = entry("observe");
  if (observe)
    lines.push(`Keeps text from: ${change(before("observe"), observe.after, observeMode)}`);
  const owner = entry("owner_user_id");
  if (typeof owner?.after === "string") {
    lines.push(`Owner: ${mention(readSet.ownerUserId)} → ${person(owner.after, names)}`);
  }
  for (const { userId, after } of allowlist(approval)) {
    if (after === null) {
      lines.push(`Stops allowing ${person(userId, names)}`);
      continue;
    }
    const label = labelOf(after);
    lines.push(`Allows ${person(userId, names)}${label ? `, labelled “${label}”` : ""}`);
  }

  if (readSet.link !== "none" && readSet.link.status !== "active") {
    lines.push(linkState(readSet.link));
  }
  lines.push(`${channelReference(readSet.monitored.channelId)} is ${audience(readSet.monitored)}`);
  if (readSet.publish.channelId !== readSet.monitored.channelId) {
    lines.push(`${channelReference(readSet.publish.channelId)} is ${audience(readSet.publish)}`);
  }
  return lines;
}

function caution(approval: Approval): string {
  const notes: string[] = [];
  if (approval.action === "owner") notes.push("The new owner approves every change from then on.");
  if (allowed(approval).length > 0) {
    notes.push("The lead acts with your access when it answers people you allow.");
  }
  notes.push("Approve only if you expected this.");
  return notes.join(" ");
}

function buttons(approvalId: string): CardButton[] {
  return [
    {
      type: "button",
      action_id: APPROVE_ACTION_ID,
      text: { type: "plain_text", text: "Approve" },
      value: approvalId,
      style: "primary",
    },
    {
      type: "button",
      action_id: REJECT_ACTION_ID,
      text: { type: "plain_text", text: "Reject" },
      value: approvalId,
    },
  ];
}

function stateLine(approval: Approval): string {
  const owner = mention(approval.readSet.ownerUserId);
  // Only the owner the card asked can decide it, so that's who decided.
  const decider = approval.decidedBy === null ? owner : mention(approval.decidedBy);
  switch (approval.state) {
    case "pending":
      return `Only ${owner} can approve or reject this · Expires ${date(approval.expiresAt)}`;
    case "approved":
      return `Approved by ${decider} · Applying it now`;
    case "applied":
      return `Approved by ${decider} and applied`;
    case "rejected":
      return `Rejected by ${decider}`;
    case "expired":
      return "Expired before anyone approved it";
    case "stale": {
      const because = approval.staleReason ? ` because ${staleReasons[approval.staleReason]}` : "";
      return approval.decidedBy === null
        ? `No longer applies${because}`
        : `Approved by ${decider}, but it no longer applies${because}`;
    }
  }
}

function linkState(link: ReadSetLink): string {
  const suspension =
    link.status === "suspended" &&
    link.statusReason !== null &&
    Object.hasOwn(suspensions, link.statusReason)
      ? suspensions[link.statusReason as keyof typeof suspensions]
      : null;
  return suspension ? `The link is suspended ${suspension.because}` : `The link is ${link.status}`;
}

function audience(channel: Audience): string {
  const kind = channel.kind === "public" ? "a public channel" : "a private channel";
  if (channel.external) return `${kind} shared with another organization`;
  const workspaces = channel.workspaces.length;
  if (channel.orgShared) {
    return workspaces > 1
      ? `${kind} shared with ${workspaces} workspaces in your Enterprise org`
      : `${kind} shared across your Enterprise org`;
  }
  return workspaces > 1 ? `${kind} in ${workspaces} workspaces` : kind;
}

/** A value as it was and as the patch leaves it, or only the latter when there was none. */
function change(before: Json | undefined, after: Json, show: (value: Json) => string): string {
  return before === undefined || before === null ? show(after) : `${show(before)} → ${show(after)}`;
}

function channelValue(value: Json): string {
  return typeof value === "string" ? channelReference(value) : "an unknown channel";
}

function requestMode(value: Json): string {
  return value === "all" ? "every new message" : "mentions of the bot";
}

function observeMode(value: Json): string {
  return value === "channel" ? "everyone in the channel" : "people you allow and their threads";
}

/** The allowlist entries a patch changes, in its order. */
function allowlist(approval: Pick<Approval, "patch">): { userId: string; after: Json }[] {
  return approval.patch.flatMap((entry) => {
    const userId = allowlistUser(entry.field);
    return userId === null ? [] : [{ userId, after: entry.after }];
  });
}

/** The people a patch allows, leaving out any entry it removes. */
function allowed(approval: Pick<Approval, "patch">): { userId: string; after: Json }[] {
  return allowlist(approval).filter((entry) => entry.after !== null);
}

function allowedNames(approval: Approval, names: CardNames): string {
  const people = allowed(approval).map((entry) => name(entry.userId, names));
  return people.length <= 2 ? people.join(" and ") : `${people.length} people`;
}

function labelOf(after: Json): string | null {
  if (typeof after !== "object" || after === null || Array.isArray(after)) return null;
  const label = (after as { readonly [key: string]: Json }).label;
  return typeof label === "string" ? plain(label, LABEL_LIMIT) || null : null;
}

/** Someone's stored name, or their ID when the bridge has none. */
function name(userId: string, names: CardNames): string {
  const stored = names[userId];
  return (stored && plain(stored, NAME_LIMIT)) || slackId(userId);
}

/** Someone's stored name with their ID, which is what a lookalike name can't copy. */
function person(userId: string, names: CardNames): string {
  const stored = names[userId];
  const shown = stored ? plain(stored, NAME_LIMIT) : "";
  return shown ? `${shown} (${slackId(userId)})` : slackId(userId);
}

/** Slack's IDs, which are 9 to 11 capitals and digits today. Anything else shows as text. */
const slackIdShape = /^[A-Z0-9]{1,32}$/;

function mention(userId: string): string {
  return slackIdShape.test(userId) ? `<@${userId}>` : plain(userId, NAME_LIMIT);
}

function channelReference(channelId: string): string {
  return slackIdShape.test(channelId) ? `<#${channelId}>` : plain(channelId, NAME_LIMIT);
}

function slackId(id: string): string {
  return slackIdShape.test(id) ? `\`${id}\`` : plain(id, NAME_LIMIT);
}

/**
 * Text someone else chose, on one line, taking at most `limit` characters of the card and cut
 * between graphemes so no character breaks. Nothing in it can format code, link or mention, and
 * no direction control can reorder the text that follows it.
 */
function plain(text: string, limit: number): string {
  const flat = text
    .replace(directionControls, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/@(here|channel|everyone)\b/gi, "@\u200b$1");
  const parts = Array.from(graphemes.segment(flat), ({ segment }) => escape(segment));
  const whole = parts.join("");
  if (whole.length <= limit) return whole;
  let shown = "";
  for (const part of parts) {
    if (shown.length + part.length > limit - 1) break;
    shown += part;
  }
  return `${shown}…`;
}

function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "'");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const directionControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** A time each reader sees in their own time zone, with UTC where Slack can't format it. */
function date(at: number): string {
  const iso = new Date(at).toISOString();
  return `<!date^${Math.floor(at / 1000)}^{date_short_pretty} at {time}|${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC>`;
}

function section(text: string): CardBlock {
  return { type: "section", text: { type: "mrkdwn", text, verbatim: true } };
}

function context(text: string): CardBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text, verbatim: true }] };
}

/** Lines joined into as few texts as fit a section each, never breaking a line. */
function packLines(lines: readonly string[]): string[] {
  const texts: string[] = [];
  for (const line of lines) {
    const last = texts.at(-1);
    if (last !== undefined && last.length + 1 + line.length <= SECTION_LIMIT) {
      texts[texts.length - 1] = `${last}\n${line}`;
    } else {
      texts.push(line);
    }
  }
  return texts;
}
