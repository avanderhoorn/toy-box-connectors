// The commands that post to Slack or take a post back. Each goes through the outbox, which reserves
// every reply and publication before sending it, so a second reply or publish for the same request
// or run is refused and names the first, and a deleted post's reservation stays. A post reserves
// nothing, so the outbox refuses only the same text in the same place while that may still go out,
// and for a while after it does. A post's images upload before the outbox queues it, so a command
// that shows any answers once Slack has them. The outbox's refusals reach the lead as the
// command's, after what didn't happen.

import type { BridgeDatabase } from "@bridge/server/database";
import { threadReference } from "@commands/model";
import { CommandRefusedError } from "@commands/model/protocol";
import { personName } from "@commands/model/slackText";
import { clockTime, count } from "@commands/model/wording";
import type { OutboxWorker } from "@outbox/server";
import {
  OutboxRefusedError,
  queuePost,
  queuePublication,
  queueReply,
} from "@outbox/server/database";
import { retractPost } from "@outbox/server/retract";
import { queueWithImages, type LeadImage, type UploadTimings } from "@outbox/server/uploads";
import type { BotClient } from "@slackapi/server/botClient";
import { readSlackPersonName } from "@slackapi/server/users";
import {
  findRoutine,
  latestScheduledRun,
  PUBLISH_COMMAND,
  type ToyBoxRoutine,
} from "@toybox/model";
import { readCallerLink, readLinkRequest, SEE_INBOX } from "./link";
import type { CommandHandler } from "./serve";

export type QueueCommandOptions = {
  database: BridgeDatabase;
  /** Slack's Web API, which a post's images upload through, or null when the bridge has no tokens. */
  bot: BotClient | null;
  outbox?: Pick<OutboxWorker, "poke">;
  timings?: UploadTimings;
};

/** Queues the answer to a request in its thread. Only Slack's confirmation answers it. */
export function replyCommand({
  database,
  bot,
  outbox,
  timings,
}: QueueCommandOptions): CommandHandler<"reply"> {
  return async ({ request: id, text, ...input }, { channelId, at }) => {
    const images = pairedImages(input);
    const { post } = await outboxRefusal(`r${id} wasn't answered.`, SEE_INBOX, () =>
      queueWithImages(
        database,
        bot,
        images,
        async (transaction, shown) => {
          const link = await readCallerLink(transaction, channelId);
          await readLinkRequest(transaction, link, id);
          return {
            post: await queueReply(transaction, { requestId: id, text, images: shown }, at),
          };
        },
        timings,
      ),
    );
    outbox?.poke();
    return {
      result: { request: `r${id}`, post: `o${post.number}`, state: post.state },
      text: `Queued o${post.number}${showing(images)} to answer r${id} in its thread. If it can't post, inbox shows r${id} again.`,
    };
  };
}

export type PublishCommandOptions = QueueCommandOptions & {
  /** The Toy Box channel's routines, or null when Toy Box has no such channel. */
  routines: (channelId: string) => Promise<readonly ToyBoxRoutine[] | null>;
};

/** Queues a post in the watched channel for the latest scheduled run of the routine that runs it. */
export function publishCommand({
  database,
  bot,
  routines,
  outbox,
  timings,
}: PublishCommandOptions): CommandHandler<"publish"> {
  return async ({ series, text, ...input }, { channelId, at }) => {
    const link = await database.read((sql) => readCallerLink(sql, channelId));
    const command = `${PUBLISH_COMMAND} ${series}`;
    const routine = findRoutine((await routines(link.toyBoxChannelId)) ?? [], command);
    if (!routine) {
      throw new CommandRefusedError(
        `Nothing posted, because no routine in this channel runs \`${command}\`. Publish posts once for each scheduled run of that routine, so create it first.`,
      );
    }
    const scheduledAt = latestScheduledRun(routine.schedule, at);
    const run = `the run of "${routine.title}" scheduled ${clockTime(scheduledAt)}`;
    const images = pairedImages(input);
    const { post } = await outboxRefusal(`Nothing posted for ${run}.`, "", () =>
      queueWithImages(
        database,
        bot,
        images,
        async (transaction, shown) => ({
          post: await queuePublication(
            transaction,
            { linkId: link.id, series, scheduledAt, text, images: shown },
            at,
          ),
        }),
        timings,
      ),
    );
    outbox?.poke();
    return {
      result: { post: `o${post.number}`, series, scheduledAt, state: post.state },
      text: `Queued o${post.number}${showing(images)} in ${link.channel} for ${run}.`,
    };
  };
}

/**
 * Queues a post the owner or a routine asked for, in the watched channel or one of its threads,
 * and names whom it'll notify, so the lead sees any mention it meant that the post won't make.
 */
export function postCommand({
  database,
  bot,
  outbox,
  timings,
}: QueueCommandOptions): CommandHandler<"post"> {
  return async ({ thread, mention: mentions = [], text, ...input }, { channelId, at }) => {
    const mentioned = [...new Set(mentions)];
    const images = pairedImages(input);
    const { link, post, names } = await outboxRefusal("Nothing posted.", "", () =>
      queueWithImages(
        database,
        bot,
        images,
        async (transaction, shown) => {
          const link = await readCallerLink(transaction, channelId);
          const post = await queuePost(
            transaction,
            { link, thread, text, mentions: mentioned, images: shown },
            at,
          );
          const names: string[] = [];
          for (const userId of mentioned) {
            names.push(personName(await readSlackPersonName(transaction, userId), userId));
          }
          return { link, post, names };
        },
        timings,
      ),
    );
    outbox?.poke();
    const reference = thread ? threadReference(thread) : null;
    const place = reference ? `${reference}'s thread` : link.channel;
    const notifying = names.length ? `, mentioning ${new Intl.ListFormat("en").format(names)}` : "";
    return {
      result: {
        post: `o${post.number}`,
        thread: reference,
        mentions: mentioned,
        state: post.state,
      },
      text: `Queued o${post.number}${showing(images)} in ${place}${notifying}.`,
    };
  };
}

export type RetractCommandOptions = {
  database: BridgeDatabase;
  /** Slack's Web API, or null when the bridge has no Slack tokens. */
  bot: BotClient | null;
};

/** Deletes one of the link's confirmed posts from Slack, keeping what it answered used. */
export function retractCommand({
  database,
  bot,
}: RetractCommandOptions): CommandHandler<"retract"> {
  return async ({ post: number }, { channelId, at }) => {
    const link = await database.read((sql) => readCallerLink(sql, channelId));
    const didnt = `o${number} wasn't deleted.`;
    if (bot === null) throw new CommandRefusedError(`${didnt} Slack isn't active.`);
    const post = await outboxRefusal(didnt, "", () =>
      retractPost(database, bot, link.id, number, at),
    );
    const used =
      post?.kind === "post" ? "" : " Its request or run stays used, so nothing posts in its place.";
    return {
      result: { post: `o${number}`, state: "retracted" },
      text: `Deleted o${number} from Slack.${used}`,
    };
  };
}

/** The images a post shows, each with the alt text given in the same place. */
function pairedImages({ image = [], alt = [] }: { image?: Uint8Array[]; alt?: string[] }) {
  return image.map((bytes, index): LeadImage => ({ bytes, alt: alt[index]! }));
}

function showing(images: readonly LeadImage[]): string {
  return images.length ? ` with ${count(images.length, "image")}` : "";
}

async function outboxRefusal<Result>(
  didnt: string,
  next: string,
  act: () => Promise<Result>,
): Promise<Result> {
  try {
    return await act();
  } catch (error) {
    if (!(error instanceof OutboxRefusedError)) throw error;
    throw new CommandRefusedError([didnt, error.message, next].filter(Boolean).join(" "));
  }
}
