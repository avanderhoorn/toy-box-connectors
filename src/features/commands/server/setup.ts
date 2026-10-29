// Link, resume and allow widen who can make the lead act or who reads its answers, so each applies
// only the change the owner confirmed (see ./owner), worked out again as it writes. Deny, pause and
// unlink only narrow, so they apply at once and the lead may run them.

import { deleteLinkActivity } from "@activity/server/ledger";
import type { BridgeDatabase } from "@bridge/server/database";
import { CommandRefusedError, type CommandAnswer } from "@commands/model/protocol";
import { admissionRefusal, approvalRefusal, linkPreview } from "@commands/model/setup";
import { channelName, oneLine, personName } from "@commands/model/slackText";
import { count } from "@commands/model/wording";
import { admissionProblem } from "@links/model/admission";
import { approvableAudience } from "@links/model/audience";
import { allowPerson, denyPeople, readChannelLink, readToyBoxLink } from "@links/server/database";
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
import type { WakeScheduler } from "@wakes/server";
import { callerChannel, readCallerLink, type CallerLink } from "./link";
import { confirmWidening } from "./owner";
import type { CommandContext, CommandHandler } from "./serve";

export type SetupCommandOptions = {
  database: BridgeDatabase;
  bot: BotClient | null;
  toyBoxOrigin: URL;
  wakes: Pick<WakeScheduler, "reconsider">;
};

export function linkCommand(options: SetupCommandOptions): CommandHandler<"link"> {
  return ({ slackChannel, requests, observe }, context) =>
    linkChannel(options, context, slackChannel, { requestMode: requests, observe });
}

export function resumeCommand(options: SetupCommandOptions): CommandHandler<"resume"> {
  return async (_input, context) => {
    const link = await options.database.read((sql) => readCallerLink(sql, context.caller));
    return linkChannel(options, context, link.slackChannelId, {});
  };
}

export function pauseCommand({ database, wakes }: SetupCommandOptions): CommandHandler<"pause"> {
  return async (_input, { caller, at }) => {
    const link = await database.write(async (transaction) => {
      const link = await readCallerLink(transaction, caller);
      await pauseLink(transaction, link.id, at);
      return link;
    });
    wakes.reconsider();
    const status = link.status === "active" ? "paused" : link.status;
    return {
      result: { status },
      text: `The link to ${link.channel} is ${status}, so the lead won't answer or post there until the owner runs \`toy-box-slack resume\`.`,
    };
  };
}

/** Deletes everything the bridge kept for the link. */
export function unlinkCommand({ database, wakes }: SetupCommandOptions): CommandHandler<"unlink"> {
  return async (_input, { caller }) => {
    const link = await database.write(async (transaction) => {
      const link = await readCallerLink(transaction, caller);
      await deleteLinkActivity(transaction, link);
      await deleteLinkRequests(transaction, link.id);
      await deleteLink(transaction, link.id);
      return link;
    });
    wakes.reconsider();
    return {
      result: { unlinked: link.slackChannelId },
      text: `Unlinked ${link.channel} and deleted what the bridge kept for it. The lead should delete its routines that run toy-box-slack.`,
    };
  };
}

/** Admits only full members, as Slack describes them now. */
export function allowCommand({ database, bot }: SetupCommandOptions): CommandHandler<"allow"> {
  return async ({ users }, { caller, at, confirmed }) => {
    const { slack, home } = await readSlackHome(database, bot);
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
      const link = await readCallerLink(transaction, caller);
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
export function denyCommand({ database, wakes }: SetupCommandOptions): CommandHandler<"deny"> {
  return async ({ users }, { caller, at }) => {
    const { link, cancelled } = await database.write(async (transaction) => {
      const link = await readCallerLink(transaction, caller);
      // An Enterprise member can be named by either of their IDs, and each is denied.
      const ids = await Promise.all(users.map((userId) => readPersonIds(transaction, userId)));
      const denied = new Set(ids.flat());
      await denyPeople(transaction, link.id, [...denied]);
      const asked = (await readActiveRequests(transaction, link.id)).filter((request) =>
        denied.has(request.requesterUserId),
      );
      for (const request of asked) {
        await cancelStoredRequest(transaction, request, "requester_denied", at);
      }
      return { link, cancelled: asked.length };
    });
    wakes.reconsider();
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
 */
async function linkChannel(
  { database, bot, toyBoxOrigin, wakes }: SetupCommandOptions,
  { caller, at, confirmed }: CommandContext,
  slackChannelId: string,
  wanted: Partial<Pick<CallerLink, "requestMode" | "observe">>,
): Promise<CommandAnswer> {
  const toyBoxChannelId = callerChannel(caller);
  const toyBox = await readLinkableChannel(toyBoxOrigin, toyBoxChannelId);
  const { slack, home } = await readSlackHome(database, bot);
  const facts = await askSlack(slack, "conversations.info", (client) =>
    fetchChannelFacts(client, slackChannelId),
  );
  const channel = channelName(facts?.name, slackChannelId);
  const approved = approvableAudience(facts, home);
  if (typeof approved === "string") {
    throw new CommandRefusedError(approvalRefusal(approved, channel));
  }
  const answer = await database.write(async (transaction) => {
    const link = await readToyBoxLink(transaction, toyBoxChannelId);
    if (link && link.slackChannelId !== slackChannelId) {
      throw new CommandRefusedError(
        `This Toy Box channel is linked to ${channelName(null, link.slackChannelId)}. Run \`toy-box-slack unlink\` before you link it to another channel.`,
      );
    }
    if (!link && (await readChannelLink(transaction, slackChannelId))) {
      throw new CommandRefusedError(
        `${channel} is linked to another Toy Box channel. Unlink it there before you link it here.`,
      );
    }
    const requestMode = wanted.requestMode ?? link?.requestMode ?? "mention";
    const observe = wanted.observe ?? link?.observe ?? "requesters";
    const preview = linkPreview(toyBox, channel, approved, { requestMode, observe });
    const ask = confirmWidening(preview, confirmed);
    if (ask) return ask;
    const settings = { requestMode, observe };
    await approveLink(transaction, { toyBoxChannelId, slackChannelId, ...settings, approved }, at);
    return {
      result: { slackChannel: slackChannelId, status: "active", ...settings },
      text: `The lead of ${toyBox} answers in ${channel} now, for the people \`toy-box-slack allow\` names.`,
    };
  });
  wakes.reconsider();
  return answer;
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
async function readSlackHome(database: BridgeDatabase, bot: BotClient | null) {
  const home = await database.read(readInstallation);
  if (!bot || home?.status !== "active") {
    throw new CommandRefusedError(
      "The bridge isn't connected to Slack, so nothing changed. Run `toy-box-slack status` to see why.",
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
