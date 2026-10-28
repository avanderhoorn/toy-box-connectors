import type { ChannelFacts } from "./channels";
import type { SlackMessage } from "./messages";
import type { SlackTs } from "./ts";
import type { SlackPerson } from "./users";

/**
 * The owner asks the bot something at the root of the channel `createStoredLink` links, at `ts`.
 * `changes` replace its fields, such as its author or text.
 */
export function askMessage(
  ts: SlackTs = "1700000100.000100",
  changes: Partial<SlackMessage> = {},
): SlackMessage {
  return {
    channelId: "C-link",
    ts,
    threadTs: null,
    rootTs: ts,
    isReply: false,
    userId: "U-owner",
    teamId: "T-home",
    subtype: null,
    author: "person",
    text: "<@U-bot> can you look at the deploy?",
    mentions: ["U-bot"],
    mentionsBot: true,
    editedTs: null,
    version: ts,
    ...changes,
  };
}

/** The owner says more at `ts` in `root`'s thread, mentioning no one. `changes` replace its fields. */
export function replyMessage(
  root: SlackMessage,
  ts: SlackTs,
  changes: Partial<SlackMessage> = {},
): SlackMessage {
  return askMessage(ts, {
    channelId: root.channelId,
    threadTs: root.rootTs,
    rootTs: root.rootTs,
    isReply: true,
    text: "it fails on the migration step",
    mentions: [],
    mentionsBot: false,
    ...changes,
  });
}

/** `message` edited at `editedTs` to say `text`, which mentions the bot when it holds its mention. */
export function editMessage(message: SlackMessage, editedTs: SlackTs, text: string): SlackMessage {
  const mentions = text.includes("<@U-bot>") ? ["U-bot"] : [];
  return {
    ...message,
    text,
    mentions,
    mentionsBot: mentions.length > 0,
    editedTs,
    version: editedTs,
  };
}

/** The private channel `createStoredLink` links, as the bot last read it. `changes` replace its facts. */
export function channelFacts(changes: Partial<ChannelFacts> = {}): ChannelFacts {
  return {
    id: "C-link",
    name: "toy-box-private",
    kind: "private",
    isMember: true,
    isArchived: false,
    isExtShared: false,
    isPendingExtShared: false,
    isOrgShared: false,
    enterpriseId: null,
    contextTeamId: "T-home",
    sharedTeamIds: ["T-home"],
    ...changes,
  };
}

/** U-carol, a full member of T-home, as users.info describes her. `changes` replace her fields. */
export function slackPerson(changes: Partial<SlackPerson> = {}): SlackPerson {
  return {
    id: "U-carol",
    teamId: "T-home",
    enterpriseId: null,
    enterpriseUserId: null,
    isBot: false,
    isWorkflowBot: false,
    deleted: false,
    isRestricted: false,
    isUltraRestricted: false,
    displayName: "carol",
    realName: "Carol Chen",
    ...changes,
  };
}
