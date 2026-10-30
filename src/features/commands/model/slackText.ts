// The lead may quote what people wrote in Toy Box or in a reply, so nothing rendered mentions anyone
// in Toy Box: every @ that toy-box/src/features/channels/model/agent.ts reads as a mention gets a
// zero-width space after it. Names shown outside a fence also lose anything that could pass for a
// label the bridge adds.

import type { Request } from "@requests/model/lifecycle";

/** The names the bridge stored for people, by user ID. */
export type SlackNames = ReadonlyMap<string, string>;

const NAME_LIMIT = 80;

// Markup, or an entity Slack escapes outside it, so each is read exactly once.
const markupPattern = /<([^<>]*)>|&(amp|lt|gt);/g;

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">" };

// Toy Box's mention boundary and handle start, so an address like dev@example.com stays text.
const mentionPattern = /(^|[^a-z0-9-])@(?=[a-z0-9])/gi;

// Controls a terminal would act on. A message keeps its line breaks and tabs.
const controls = /[^\P{Cc}\n\t]/gu;

const directionControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Brackets of every script, so a name can't pass for a label the bridge adds, and the dot between
// a heading's fields.
const labelMarks = /[\p{Ps}\p{Pe}\u00b7]/gu;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function mentionedUsers(text: string): string[] {
  return Array.from(text.matchAll(/<@([^|<>]+)/g), ([, userId]) => userId!);
}

export function renderSlackText(text: string, names: SlackNames): string {
  const rendered = text.replace(markupPattern, (_, inner?: string, entity?: string) =>
    inner === undefined ? entities[entity!]! : renderMarkup(inner, names),
  );
  // Neutralized once whole, so a boundary before markup can't pair with a handle it renders.
  return neutralizeMentions(rendered.replace(controls, ""));
}

/** A name safe to print beside the labels the bridge adds, or the user ID when there's none. */
export function personName(name: string | null | undefined, userId: string): string {
  const shown = oneLine((name ?? "").replace(labelMarks, " "), NAME_LIMIT);
  return shown || oneLine(userId.replace(labelMarks, " "), NAME_LIMIT);
}

/** A channel as #name, or by its ID when the bridge has no name. */
export function channelName(name: string | null | undefined, channelId: string): string {
  return `#${oneLine(name || channelId, NAME_LIMIT)}`;
}

/** A Toy Box channel as its name in quotes, or by its ID when the bridge has no name. */
export function toyBoxChannelName(name: string | null | undefined, channelId: string): string {
  const shown = oneLine(name ?? "", NAME_LIMIT);
  return shown ? `"${shown}"` : channelId;
}

/** A request's Slack link, opening its thread, or null until Slack has said the workspace's URL. */
export function permalink(
  workspaceUrl: string | null,
  { channelId, sourceTs, rootTs }: Pick<Request, "channelId" | "sourceTs" | "rootTs">,
): string | null {
  if (workspaceUrl === null) return null;
  const archive = `${workspaceUrl.replace(/\/?$/, "/")}archives/${channelId}`;
  const message = `${archive}/p${sourceTs.replace(".", "")}`;
  return sourceTs === rootTs ? message : `${message}?thread_ts=${rootTs}`;
}

/**
 * Text someone else chose, on one line and cut between graphemes. No control or direction mark
 * survives, a backtick can't open code, and nothing in it mentions anyone in Toy Box.
 */
export function oneLine(text: string, limit: number): string {
  const flat = text.replace(directionControls, "").replace(controls, "").replace(/\s+/g, " ");
  return cut(neutralizeMentions(flat.trim().replaceAll("`", "'")), limit);
}

/** `text` cut after `limit` graphemes, so an emoji stays whole, and how many graphemes it cut. */
export function cutText(text: string, limit: number): { text: string; cut: number } {
  const characters = Array.from(graphemes.segment(text), ({ segment }) => segment);
  if (characters.length <= limit) return { text, cut: 0 };
  return { text: characters.slice(0, limit).join(""), cut: characters.length - limit };
}

/** A code fence longer than any run of backticks in `text`, so nothing in it can close the fence. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const [run] of text.matchAll(/`+/g)) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

function renderMarkup(inner: string, names: SlackNames): string {
  const bar = inner.indexOf("|");
  const target = bar === -1 ? inner : inner.slice(0, bar);
  const label = bar === -1 ? "" : unescape(inner.slice(bar + 1));
  const id = target.slice(1);
  if (target.startsWith("@"))
    return `{${personName(names.get(id) ?? label.replace(/^@/, ""), id)}}`;
  if (target.startsWith("#")) return channelName(label.replace(/^#/, ""), id);
  if (target.startsWith("!")) return special(id, label);
  return link(unescape(target), label);
}

// Broadcasts as Slack shows them, and user groups and dates by their label.
function special(target: string, label: string): string {
  const [command, argument] = target.split("^");
  if (command === "here" || command === "channel" || command === "everyone") return `@${command}`;
  return label || `@${argument ?? command}`;
}

// A URL's mentions become %40, which servers read the same, where a zero-width space would break it.
function link(url: string, label: string): string {
  const shown = url.replace(/^mailto:/, "");
  const opened = shown.replace(mentionPattern, "$1%40");
  if (!label || label === shown || label === url.replace(/^https?:\/\//, "")) return opened;
  return `${label} (${opened})`;
}

function neutralizeMentions(text: string): string {
  return text.replace(mentionPattern, "$1@\u200b");
}

function unescape(text: string): string {
  return text.replace(/&(amp|lt|gt);/g, (_, name: string) => entities[name]!);
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let shown = "";
  for (const { segment } of graphemes.segment(text)) {
    if (shown.length + segment.length > limit - 1) break;
    shown += segment;
  }
  return `${shown.trimEnd()}…`;
}
