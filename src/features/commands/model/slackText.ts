// Slack text as the lead reads it.
//
// The lead reads what people wrote in Slack and may quote it in Toy Box or in a reply, so the
// bridge renders Slack's markup before the lead sees it. A person shows as {Name} and a channel as
// #name, by the names the bridge stored, a link as its label and URL, and an entity as its
// character. Nothing rendered mentions anyone in Toy Box: every @ that Toy Box's grammar in
// toy-box/src/features/channels/model/agent.ts reads as a mention gets a zero-width space after
// it, except in a URL, where it's percent-encoded instead so the URL still opens. Names and other
// text shown outside a fence also lose anything that could pass for a label the bridge adds.

/** The names the bridge stored for the people and channels a text refers to, by ID. */
export type SlackNames = {
  people: ReadonlyMap<string, string>;
  channels: ReadonlyMap<string, string>;
};

/** The most characters a person's or a file's name shows. */
export const NAME_LIMIT = 80;

const markupPattern = /<([^<>]*)>/g;

// Toy Box's mention boundary and handle start, so an address like dev@example.com stays text.
const mentionPattern = /(^|[^a-z0-9-])@(?=[a-z0-9])/gi;

// Controls a terminal would act on. A message keeps its line breaks and tabs.
const controls = /[^\P{Cc}\n\t]/gu;

const directionControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Brackets of every script, so a name can't pass for a label the bridge adds, and the dot between
// a heading's fields.
const labelMarks = /[\p{Ps}\p{Pe}\u00b7]/gu;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">" };

/** Rendered text, marking the URLs, whose mentions are neutralized so they still open. */
type Piece = { text: string; url?: true };

/** The people and channels a text's markup refers to, so their names can be read first. */
export function slackReferences(text: string): { people: string[]; channels: string[] } {
  const people = new Set<string>();
  const channels = new Set<string>();
  for (const [, inner] of text.matchAll(markupPattern)) {
    const target = inner!.split("|", 1)[0]!;
    if (target.startsWith("@")) people.add(target.slice(1));
    else if (target.startsWith("#")) channels.add(target.slice(1));
  }
  return { people: [...people], channels: [...channels] };
}

/** A message's text with Slack's markup rendered, its line breaks kept. */
export function renderSlackText(text: string, names: SlackNames): string {
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const match of text.matchAll(markupPattern)) {
    pieces.push({ text: unescape(text.slice(cursor, match.index)) });
    pieces.push(...renderMarkup(match[1]!, names));
    cursor = match.index + match[0].length;
  }
  pieces.push({ text: unescape(text.slice(cursor)) });
  return neutralizePieces(pieces.map((piece) => ({ ...piece, text: stripControls(piece.text) })));
}

/** Text without the mention of `userId` it opens with, as people address the bot. */
export function withoutLeadingMention(text: string, userId: string): string {
  const trimmed = text.trimStart();
  const opening = /^<@([^|>]*)(?:\|[^>]*)?>[\s,:]*/.exec(trimmed);
  return opening?.[1] === userId ? trimmed.slice(opening[0].length) : text;
}

/**
 * A person's name, made safe to print beside the labels the bridge adds: one line, no bracket and
 * no field separator. Someone the bridge can't name shows by their user ID.
 */
export function personName(name: string | null, userId: string): string {
  const shown = name === null ? "" : oneLine(name.replace(labelMarks, " "), NAME_LIMIT);
  return shown || oneLine(userId.replace(labelMarks, " "), NAME_LIMIT);
}

/**
 * Text someone else chose, on one line, taking at most `limit` characters cut between graphemes.
 * No control or direction mark survives, a backtick becomes a quote so it can't open code, and
 * nothing in it mentions anyone in Toy Box.
 */
export function oneLine(text: string, limit: number): string {
  const flat = stripControls(text.replace(directionControls, ""))
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("`", "'");
  return cut(neutralizeMentions(flat), limit);
}

/** Puts a zero-width space after every @ that Toy Box would read as a mention. */
export function neutralizeMentions(text: string): string {
  return text.replace(mentionPattern, "$1@\u200b");
}

/** A code fence longer than any run of backticks in `text`, so nothing in it can close the fence. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const [run] of text.matchAll(/`+/g)) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

function renderMarkup(inner: string, names: SlackNames): Piece[] {
  const bar = inner.indexOf("|");
  const target = bar === -1 ? inner : inner.slice(0, bar);
  const label = bar === -1 ? "" : unescape(inner.slice(bar + 1));
  if (target.startsWith("@")) {
    const userId = target.slice(1);
    const name = names.people.get(userId) ?? (label.replace(/^@/, "") || null);
    return [{ text: `{${personName(name, userId)}}` }];
  }
  if (target.startsWith("#")) {
    const channelId = target.slice(1);
    const name = names.channels.get(channelId) ?? (label.replace(/^#/, "") || channelId);
    return [{ text: `#${oneLine(name, NAME_LIMIT)}` }];
  }
  if (target.startsWith("!")) return [{ text: special(target.slice(1), label) }];
  return link(unescape(target), label);
}

// Broadcasts, user groups and dates. The @ a broadcast or group shows is neutralized with the rest.
function special(target: string, label: string): string {
  const [command, argument] = target.split("^");
  switch (command) {
    case "here":
    case "channel":
    case "everyone":
      return `@${command}`;
    case "subteam":
      return label || `@${argument ?? "group"}`;
    default:
      return label || command!;
  }
}

function link(url: string, label: string): Piece[] {
  const shown = url.startsWith("mailto:") ? url.slice("mailto:".length) : url;
  if (!label || label === shown || label === url.replace(/^https?:\/\//, "")) {
    return [{ text: shown, url: true }];
  }
  return [{ text: `${label} (` }, { text: shown, url: true }, { text: ")" }];
}

// Neutralizes mentions across the joined pieces, so a boundary in one piece can't pair with a
// handle in the next. A URL's @ becomes %40, which servers read the same, where a zero-width space
// would break the URL.
function neutralizePieces(pieces: readonly Piece[]): string {
  let joined = "";
  const urls: [start: number, end: number][] = [];
  for (const piece of pieces) {
    if (piece.url) urls.push([joined.length, joined.length + piece.text.length]);
    joined += piece.text;
  }
  return joined.replace(mentionPattern, (_, before: string, offset: number) => {
    const at = offset + before.length;
    const inUrl = urls.some(([start, end]) => at >= start && at < end);
    return `${before}${inUrl ? "%40" : "@\u200b"}`;
  });
}

function unescape(text: string): string {
  return text.replace(/&(amp|lt|gt);/g, (_, name: string) => entities[name]!);
}

function stripControls(text: string): string {
  return text.replace(controls, "");
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
