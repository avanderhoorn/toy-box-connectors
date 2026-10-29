// Link, resume and allow widen who can make the lead act or who reads its answers, so each applies
// only the change the owner confirmed (see ./owner), worked out again as it writes. Deny, pause and
// unlink only narrow, so they apply at once and the lead may run them.

import { deleteLinkActivity } from "@activity/server/ledger";
import type { BridgeDatabase } from "@bridge/server/database";
import { CommandRefusedError, type CommandAnswer } from "@commands/model/protocol";
import { admissionRefusal, approvalRefusal, linkPreview } from "@commands/model/setup";
import { channelName, oneLine, personName } from "@commands/model/slackText";
import { presentLinkState } from "@commands/model/status";
import { count } from "@commands/model/wording";
import { admissionProblem } from "@links/model/admission";
import { approvableAudience } from "@links/model/audience";
import { suspensions } from "@links/model/status";
import {
  allowPerson,
  denyPeople,
  readChannelLink,
  readToyBoxLink,
  type ChannelLink,
} from "@links/server/database";
import { approveLink, deleteLink, pauseLink } from "@links/server/status";
import { deleteLinkRequests, readActiveRequests } from "@requests/server/database";
import { cancelStoredRequest } from "@requests/server/lifecycle";
import type { WebClient } from "@slack/web-api";
import type { SlackPerson } from "@slackapi/model/users";
import type { BotClient } from "@slackapi/server/botClient";
import { fetchChannelFacts } from "@slackapi/server/channels";
import { readInstallation } from "@slackapi/server/installation";
import { fetchSlackPerson, readPersonIds, writeSlackPerson } from "@slackapi/server/users";
import { readToyBoxChannel } from "@toybox/server/api";
import { callerChannel, readCallerLink, type CallerLink } from "./link";
import { confirmWidening } from "./owner";
import type { CommandContext, CommandHandler } from "./serve";

export type SetupCommandOptions = {
  database: BridgeDatabase;
  bot: BotClient | null;
  toyBoxOrigin: URL;
  /** The app the commands run in, which they name once the bridge hosts several. */
  app?: string | null;
};

export function linkCommand(options: SetupCommandOptions): CommandHandler<"link"> {
  return ({ slackChannel, requests, observe }, context) =>
    linkChannel(options, context, slackChannel, { requestMode: requests, observe });
}

export function resumeCommand(options: SetupCommandOptions): CommandHandler<"resume"> {
  return async (_input, context) => {
    const link = await options.database.read((sql) => readCallerLink(sql, context.channelId));
    return linkChannel(options, context, link.slackChannelId, {});
  };
}

/** Pauses an active link. One already paused or suspended stays as it is, and says what ends it. */
export function pauseCommand({ database }: SetupCommandOptions): CommandHandler<"pause"> {
  return async (_input, { channelId, at }) => {
    const link = await database.write(async (transaction) => {
      const link = await readCallerLink(transaction, channelId);
      await pauseLink(transaction, link.id, at);
      return link;
    });
    const status = link.status === "active" ? "paused" : link.status;
    const already = link.status === "paused" ? "already " : "";
    return {
      result: { status },
      text: `The link to ${link.channel} is ${already}${presentLinkState({ ...link, status })}`,
    };
  };
}

/** Deletes everything the bridge kept for the link. */
export function unlinkCommand({ database }: SetupCommandOptions): CommandHandler<"unlink"> {
  return async (_input, { channelId }) => {
    const link = await database.write(async (transaction) => {
      const link = await readCallerLink(transaction, channelId);
      await deleteLinkActivity(transaction, link);
      await deleteLinkRequests(transaction, link.id);
      await deleteLink(transaction, link.id);
      return link;
    });
    return {
      result: { unlinked: link.slackChannelId },
      text: `Unlinked ${link.channel} and deleted what the bridge kept for it. The lead should delete its routines that run toy-box-slack.`,
    };
  };
}

/** Admits only full members, as Slack describes them now. */
export function allowCommand(options: SetupCommandOptions): CommandHandler<"allow"> {
  const { database } = options;
  return async ({ users }, { channelId, at, confirmed }) => {
    const { slack, home } = await readSlackHome(options);
    // An Enterprise member can be named by either of their IDs, and is allowed once.
    const people = new Map<string, SlackPerson>();
    for (const userId of users) {
      const person = await askSlack(slack, "users.info", (client) =>
        fetchSlackPerson(client, userId),
      );
      const problem = admissionProblem(userId, person, home);
      if (problem) throw new CommandRefusedError(admissionRefusal(shown(person, userId), problem));
      if (person) people.set(person.id, person);
    }
    return database.write(async (transaction) => {
      const link = await readCallerLink(transaction, channelId);
      const added = [...people.values()].filter((person) => !link.allowlist.has(person.id));
      const names = added.map((person) => `\n- ${shown(person, person.id)}`).join("");
      const preview = `Allowing them would let them ask the lead to act, from ${link.channel}:\n${names}`;
      const ask = added.length ? confirmWidening(preview, confirmed) : null;
      if (ask) return ask;
      for (const person of added) {
        await writeSlackPerson(transaction, person);
        await allowPerson(transaction, link.id, person.id, at);
      }
      return {
        result: { added: added.map((person) => person.id) },
        text: `They can all ask the lead to act, from ${link.channel}.`,
      };
    });
  };
}

/** Cancels whatever the people it removes are still waiting on. */
export function denyCommand({ database }: SetupCommandOptions): CommandHandler<"deny"> {
  return async ({ users }, { channelId }) => {
    const { link, cancelled } = await database.write(async (transaction) => {
      const link = await readCallerLink(transaction, channelId);
      // An Enterprise member can be named by either of their IDs, and each is denied.
      const ids = await Promise.all(users.map((userId) => readPersonIds(transaction, userId)));
      const denied = new Set(ids.flat());
      await denyPeople(transaction, link.id, [...denied]);
      const asked = (await readActiveRequests(transaction, link.id)).filter((request) =>
        denied.has(request.requesterUserId),
      );
      for (const request of asked) {
        await cancelStoredRequest(transaction, request, "requester_denied");
      }
      return { link, cancelled: asked.length };
    });
    const text = `None of them can ask the lead to act from ${link.channel} now.`;
    return {
      result: { cancelled },
      text: cancelled ? `${text} Cancelled ${count(cancelled, "request")} of theirs.` : text,
    };
  };
}

/**
 * Links the caller's Toy Box channel to `slackChannelId` and makes the link active, with the
 * settings `wanted` names, else the link's own, and the channel's audience as Slack says it is now.
 * A link Slack moved is refused before Toy Box or Slack is asked, and again as it writes, since
 * Slack can move it while they're asked.
 */
async function linkChannel(
  options: SetupCommandOptions,
  { channelId, at, confirmed }: CommandContext,
  slackChannelId: string,
  wanted: Partial<Pick<CallerLink, "requestMode" | "observe">>,
): Promise<CommandAnswer> {
  const { database, toyBoxOrigin, app = null } = options;
  const toyBoxChannelId = callerChannel(channelId);
  refuseMoved(await database.read((sql) => readToyBoxLink(sql, toyBoxChannelId)));
  const toyBox = await readLinkableChannel(toyBoxOrigin, toyBoxChannelId);
  const { slack, home } = await readSlackHome(options);
  const facts = await askSlack(slack, "conversations.info", (client) =>
    fetchChannelFacts(client, slackChannelId),
  );
  const channel = channelName(facts?.name, slackChannelId);
  const approved = approvableAudience(facts, home);
  if (typeof approved === "string") {
    throw new CommandRefusedError(approvalRefusal(approved, channel));
  }
  return database.write(async (transaction) => {
    const link = await readToyBoxLink(transaction, toyBoxChannelId);
    refuseMoved(link);
    if (link && link.slackChannelId !== slackChannelId) {
      throw new CommandRefusedError(
        `This Toy Box channel is linked to ${channelName(null, link.slackChannelId)}. Run \`toy-box-slack unlink\` before you link it to another channel.`,
      );
    }
    if (!link && (await readChannelLink(transaction, slackChannelId))) {
      throw new CommandRefusedError(
        app
          ? `${channel} is linked to another Toy Box channel through the ${app} app. Unlink it there, or link this one through another app with \`--app\`.`
          : `${channel} is linked to another Toy Box channel. Unlink it there before you link it here.`,
      );
    }
    const requestMode = wanted.requestMode ?? link?.requestMode ?? "mention";
    const observe = wanted.observe ?? link?.observe ?? "requesters";
    const preview = linkPreview(toyBox, channel, approved, { requestMode, observe }, app);
    const ask = confirmWidening(preview, confirmed);
    if (ask) return ask;
    const settings = { requestMode, observe };
    await approveLink(transaction, { toyBoxChannelId, slackChannelId, ...settings, approved }, at);
    const asBot = app ? ` as the ${app} app's bot` : "";
    return {
      result: { slackChannel: slackChannelId, status: "active", ...settings },
      text: `The lead of ${toyBox} answers in ${channel} now${asBot}, for the people \`toy-box-slack allow\` names.`,
    };
  });
}

/** Refuses a link Slack gave a new channel ID, which only unlink and a new link end. */
function refuseMoved(link: ChannelLink | null): void {
  if (link?.statusReason !== "channel_id_changed") return;
  const { because, fix } = suspensions.channel_id_changed;
  const channel = channelName(null, link.slackChannelId);
  throw new CommandRefusedError(`The link to ${channel} is suspended ${because}. ${fix}`);
}

/** The Toy Box channel's name, refusing one that's missing or whose lead isn't on Copilot. */
async function readLinkableChannel(origin: URL, channelId: string): Promise<string> {
  const channel = await readToyBoxChannel(origin, channelId);
  if (!channel) {
    throw new CommandRefusedError(`Toy Box has no channel ${channelId}, so nothing changed.`);
  }
  const name = `"${oneLine(channel.name, 80)}"`;
  if (channel.provider !== "copilot") {
    throw new CommandRefusedError(
      `The lead of ${name} runs on ${channel.provider}, and only leads on Copilot can answer in Slack.`,
    );
  }
  return name;
}

/** The bot, and the installation it acts in, refusing while the bridge can't ask Slack. */
async function readSlackHome({ database, bot, app = null }: SetupCommandOptions) {
  const home = await database.read(readInstallation);
  if (!bot || home?.status !== "active") {
    throw new CommandRefusedError(
      `${app ? `The ${app} app` : "The bridge"} isn't connected to Slack, so nothing changed. Run \`toy-box-slack status\` to see why.`,
    );
  }
  return { slack: bot, home };
}

/** What Slack answers `method`, refusing when it doesn't. */
async function askSlack<Result>(
  slack: BotClient,
  method: string,
  run: (client: WebClient) => Promise<Result>,
): Promise<Result> {
  const call = await slack.call(method, run);
  if (call.kind === "ok") return call.result;
  const problem = call.kind === "error" || call.kind === "auth_failed" ? call.error : call.kind;
  throw new CommandRefusedError(
    `Slack didn't answer ${method} (${problem}), so nothing changed. Try again in a minute.`,
  );
}

/** A person by name and ID, so the owner can tell apart two who share a name. */
function shown(person: SlackPerson | null, userId: string): string {
  return `${personName(person?.realName ?? person?.displayName, userId)} (${userId})`;
}
