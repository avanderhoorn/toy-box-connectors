import type { WebClient } from "@slack/web-api";
import { z } from "zod";
import type { Admitted } from "@links/model/approvals";
import type { FactsNeeded, FreshFacts } from "@links/model/setup";
import type { ChannelMembersPage } from "@slackapi/model/channels";
import { personIds } from "@slackapi/model/users";
import type { BotClient, SlackCall } from "@slackapi/server/botClient";
import { fetchChannelFacts, fetchChannelMembers } from "@slackapi/server/channels";
import { fetchSlackPerson } from "@slackapi/server/users";
import type { ToyBoxChannelView } from "@toybox/model/stream";
import { readToyBoxChannel } from "@toybox/server/channel";

// Fresh facts.
//
// A proposal is checked, and an approved change applies, only against what Slack and Toy Box say
// as it happens. The reader takes the Toy Box channel's snapshot, asks conversations.info for each
// Slack channel a change names and users.info for each person it admits, then pages through
// conversations.members until it finds the owner in each channel the bot is in. It stores nothing
// and runs outside any transaction. A read that fails, that Slack holds back, or that hasn't
// finished when its signal aborts proves nothing either way, so the change it was for stays
// unverified rather than being judged on a guess.

/** Why a read proves nothing, and when Slack said the bridge may ask again, if it said. */
export type Unverified = { kind: "unverified"; detail: string; retryAt: number | null };

export type FactsRead<Facts> = { kind: "read"; facts: Facts } | Unverified;

/** What Slack says about the channels and people a change names. */
export type SlackFacts = Omit<FreshFacts, "toyBox">;

export type FactsReader = {
  /** The Toy Box channel as it is now, or null when Toy Box deleted it. */
  readToyBox(
    toyboxChannelId: string,
    signal: AbortSignal,
  ): Promise<FactsRead<ToyBoxChannelView | null>>;
  /**
   * What Slack says now about the channels and people `needed` names. `ownerIds` are the IDs its
   * owner is known by, and any of them among a channel's members counts as the owner, as does any
   * ID users.info gives that owner when the change admits them.
   */
  readSlack(
    needed: FactsNeeded,
    ownerIds: readonly string[],
    signal: AbortSignal,
  ): Promise<FactsRead<SlackFacts>>;
};

/** Reads through the bot's client and the Toy Box at `toyBoxOrigin`. */
export function createFactsReader(bot: BotClient, toyBoxOrigin: URL): FactsReader {
  return {
    async readToyBox(toyboxChannelId, signal) {
      try {
        const facts = await readToyBoxChannel(toyBoxOrigin, toyboxChannelId, { signal });
        return { kind: "read", facts };
      } catch (error) {
        if (signal.aborted) return unverified("Toy Box didn't answer in time");
        return unverified(`Toy Box couldn't be read: ${describe(error)}`);
      }
    },
    async readSlack(needed, ownerIds, signal) {
      try {
        return { kind: "read", facts: await readSlackFacts(bot, needed, ownerIds, signal) };
      } catch (error) {
        if (error instanceof UnverifiedError) return error.unverified;
        throw error;
      }
    },
  };
}

async function readSlackFacts(
  bot: BotClient,
  needed: FactsNeeded,
  ownerIds: readonly string[],
  signal: AbortSignal,
): Promise<SlackFacts> {
  const channelIds = [...new Set([needed.monitored, needed.publish])];
  const [channels, people] = await Promise.all([
    Promise.all(
      channelIds.map((channelId) =>
        ask(bot, "conversations.info", (client) => fetchChannelFacts(client, channelId), signal),
      ),
    ),
    Promise.all(
      needed.people.map(async (userId): Promise<Admitted> => ({
        userId,
        person: await ask(bot, "users.info", (client) => fetchSlackPerson(client, userId), signal),
      })),
    ),
  ]);
  const owner = new Set(ownerIds);
  const admitted = people.find((each) => each.userId === needed.owner)?.person;
  for (const id of admitted ? personIds(admitted) : []) owner.add(id);
  // Only a channel the bot is in is worth reading members of, since nothing else can be linked.
  const reads = await Promise.all(
    channelIds.map(async (channelId, index) => {
      const facts = channels[index]!;
      const ownerIn = facts?.isMember ? await hasMember(bot, channelId, owner, signal) : false;
      return { channelId, facts, ownerIn };
    }),
  );
  const channel = (channelId: string) => reads.find((each) => each.channelId === channelId)!;
  return {
    monitored: channel(needed.monitored).facts,
    publish: channel(needed.publish).facts,
    ownerInMonitored: channel(needed.monitored).ownerIn,
    ownerInPublish: channel(needed.publish).ownerIn,
    people,
  };
}

/**
 * Whether any of `ids` is among `channelId`'s members, read a page at a time until one is. Slack
 * may send a page with nobody on it before the last, so only the end of the cursor ends the list.
 */
async function hasMember(
  bot: BotClient,
  channelId: string,
  ids: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<boolean> {
  let cursor: string | null = null;
  do {
    const from: string | null = cursor;
    const page: ChannelMembersPage | null = await ask(
      bot,
      "conversations.members",
      (client) => fetchChannelMembers(client, channelId, from),
      signal,
    );
    // conversations.info found the channel moments ago, so losing it now says nothing either way.
    if (!page)
      throw new UnverifiedError(`Slack lost channel ${channelId} while reading its members`);
    if (page.members.some((member) => ids.has(member))) return true;
    cursor = page.nextCursor;
  } while (cursor !== null);
  return false;
}

/**
 * Makes one call, giving up once `signal` aborts, and returns what Slack answered. Throws an
 * UnverifiedError for any other outcome, and rethrows anything that isn't Slack's doing, such as a
 * storage error.
 */
async function ask<Result>(
  bot: BotClient,
  method: string,
  run: (client: WebClient) => Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  let call: SlackCall<Result>;
  try {
    signal.throwIfAborted();
    call = await beforeAbort(bot.call(method, run), signal);
  } catch (error) {
    if (signal.aborted) throw new UnverifiedError(`Slack didn't answer ${method} in time`);
    if (error instanceof z.ZodError) {
      throw new UnverifiedError(`Slack answered ${method} with something the bridge can't read`);
    }
    throw error;
  }
  switch (call.kind) {
    case "ok":
      return call.result;
    case "unusable":
      throw new UnverifiedError(`The bridge cannot use Slack for ${method} right now`);
    case "rate_limited":
      throw new UnverifiedError(`Slack is holding back ${method}`, call.until);
    case "auth_failed":
      throw new UnverifiedError(`Slack rejected the bot token with ${call.error}`);
    case "error":
      throw new UnverifiedError(`Slack refused ${method} with ${call.error}`);
    case "unknown":
      throw new UnverifiedError(`Slack didn't answer ${method}: ${call.detail}`);
  }
}

/** Settles as `work` does, unless `signal` aborts first, which rejects with its reason. */
function beforeAbort<Result>(work: Promise<Result>, signal: AbortSignal): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

class UnverifiedError extends Error {
  readonly unverified: Unverified;

  constructor(detail: string, retryAt: number | null = null) {
    super(detail);
    this.unverified = { kind: "unverified", detail, retryAt };
  }
}

function unverified(detail: string): Unverified {
  return { kind: "unverified", detail, retryAt: null };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
