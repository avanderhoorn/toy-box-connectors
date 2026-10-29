import { catchUpWindow, changedSince, repliedSince } from "@activity/model/catchUp";
import type { BridgeDatabase } from "@bridge/server/database";
import { suspendChannelLinks } from "@links/server/lifecycle";
import type { WebClient } from "@slack/web-api";
import { issuesOf } from "@slackapi/model/envelopes";
import { channelFailureReason } from "@slackapi/model/errors";
import { continueHistory, type HistoryPage } from "@slackapi/model/history";
import {
  normalizeHistoryMessage,
  slackMessageSchema,
  type SlackMessagePayload,
} from "@slackapi/model/messages";
import { compareTs, type SlackTs } from "@slackapi/model/ts";
import type { BotClient } from "@slackapi/server/botClient";
import { fetchHistoryPage, fetchThreadPage } from "@slackapi/server/history";
import { markConnected, readConnectedAt, readInstallation } from "@slackapi/server/installation";
import { defaultWakeTimings, retryDelay, type WakeTimings } from "@wakes/model";
import { sleep } from "@/shared/sleep";
import { ingestMessageEvent } from "./ingest";

// Catching up.
//
// Slack's hello, a minute Slack held events back and a delivery the bridge couldn't read each note
// a gap in the same transaction. Once gaps end, a run reads each linked channel's history, stores
// what changed, and only then forgets the gaps it read for, never one noted since it began. It
// waits out Slack's rate limits, and a run that can't finish is retried on the wake backoff.

export interface CatchUp {
  /** Catches up on every gap that has ended, after the run in progress. */
  poke(): void;
  /** Why catching up can't finish, or null. */
  problem(): string | null;
  /** Stops once the run in progress stops, which its call to Slack in flight bounds. */
  stop(): Promise<void>;
}

export type CatchUpOptions = {
  /** Called after catching up changed a link or request. */
  onChange?: () => void;
  /** Called when catching up stops on an error that retrying can't fix, such as storage failing. */
  onError?: (error: unknown) => void;
  now?: () => number;
  /** A run that can't finish is retried on this backoff. */
  timings?: WakeTimings;
};

/** Why a run can't finish, which the next one may not hit. */
class Unfinished extends Error {}

/** Notes that the bridge may have missed what happened from `start` until `end`. */
export async function noteGap(transaction: Bun.SQL, start: number, end: number): Promise<void> {
  await transaction`INSERT INTO gaps (starts_at, ends_at) VALUES (${start}, ${end})`;
}

/** Notes Slack's hello at `helloAt`, and that anything since the last one may have been missed. */
export async function noteHello(transaction: Bun.SQL, helloAt: number): Promise<void> {
  await noteGap(transaction, (await readConnectedAt(transaction)) ?? 0, helloAt);
  await markConnected(transaction, helloAt);
}

export function startCatchUp(
  database: BridgeDatabase,
  bot: BotClient,
  {
    onChange = () => {},
    onError = () => {},
    now = Date.now,
    timings = defaultWakeTimings,
  }: CatchUpOptions = {},
): CatchUp {
  const stopping = new AbortController();
  const { signal } = stopping;
  let timer: Timer | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let failures = 0;
  let problem: string | null = null;

  function poke() {
    if (signal.aborted) return;
    again = true;
    running ??= runWhilePoked();
  }

  // A poke during a run earns one more run, however many pokes there were.
  async function runWhilePoked() {
    try {
      while (again && !signal.aborted) {
        again = false;
        await pass();
      }
    } catch (error) {
      fail(error);
    } finally {
      running = undefined;
    }
  }

  async function pass() {
    clearTimeout(timer);
    const at = now();
    const [gaps] = await database.read(
      (sql) => sql<{ since: number | null; through: number | null; next: number | null }[]>`
        SELECT min(starts_at) FILTER (WHERE ends_at <= ${at}) AS since,
          max(id) FILTER (WHERE ends_at <= ${at}) AS through,
          min(ends_at) FILTER (WHERE ends_at > ${at}) AS next
        FROM gaps
      `,
    );
    const { since, through, next } = gaps!;
    if (since !== null && through !== null) {
      try {
        await readMissed(since);
        await database.write(
          (transaction) =>
            transaction`DELETE FROM gaps WHERE id <= ${through} AND ends_at <= ${at}`,
        );
      } catch (error) {
        if (!(error instanceof Unfinished)) throw error;
        if (signal.aborted) return;
        failures += 1;
        const found = `Can't catch up on messages the bridge may have missed. ${error.message}`;
        if (problem !== found) console.error(found);
        problem = found;
        timer = setTimeout(poke, retryDelay(failures, timings));
        return;
      }
      if (problem !== null) console.error("Caught up on messages the bridge may have missed.");
      failures = 0;
      problem = null;
    }
    if (next !== null) timer = setTimeout(poke, Math.max(next - now(), 0));
  }

  /** Stores what each linked channel's history shows changed since `since`. */
  async function readMissed(since: number) {
    const links = await database.read(
      (sql) => sql<{ channelId: string; linkedAtTs: SlackTs }[]>`
        SELECT slack_channel_id AS channelId, linked_at_ts AS linkedAtTs FROM links
      `,
    );
    for (const { channelId, linkedAtTs } of links) {
      const { oldest, from } = catchUpWindow(since, linkedAtTs, now());
      const missed = await readChannel(channelId, oldest, from);
      if (missed !== null) await take(channelId, missed);
    }
  }

  /** What changed in `channelId` from `from`, or null once Slack shuts the bot out of it. */
  async function readChannel(channelId: string, oldest: SlackTs, from: SlackTs) {
    const roots = await readAll("conversations.history", channelId, (client, cursor) =>
      fetchHistoryPage(client, { channelId, oldest, cursor }),
    );
    if (roots === null) return null;
    const missed = roots.filter((message) => changedSince(message, from));
    for (const root of roots.filter((message) => repliedSince(message, from))) {
      const thread = await readAll("conversations.replies", channelId, (client, cursor) =>
        fetchThreadPage(client, { channelId, rootTs: root.ts, cursor }),
      );
      if (thread === null) return null;
      missed.push(...thread.filter((message) => changedSince(message, from)));
    }
    return missed;
  }

  /**
   * Stores `messages` from `channelId` oldest first, as live intake would have, at once so the lead
   * never sees half of what was missed. A message history and its thread both show merges once.
   */
  async function take(channelId: string, messages: SlackMessagePayload[]) {
    const changed = await database.write(async (transaction) => {
      const installation = await readInstallation(transaction);
      if (installation === null || installation.status === "uninstalled") return false;
      let changed = false;
      for (const message of messages.toSorted((left, right) => compareTs(left.ts, right.ts))) {
        const event = normalizeHistoryMessage(channelId, message, installation);
        changed = (await ingestMessageEvent(transaction, event, now())) || changed;
      }
      return changed;
    });
    if (changed) onChange();
  }

  /** Every message a listing pages through, or null when Slack shut the bot out of the channel. */
  async function readAll(
    method: string,
    channelId: string,
    fetchPage: (client: WebClient, cursor: string | null) => Promise<HistoryPage>,
  ): Promise<SlackMessagePayload[] | null> {
    const messages: SlackMessagePayload[] = [];
    const used = new Set<string>();
    let cursor: string | null = null;
    while (true) {
      const page = await ask(method, channelId, (client) => fetchPage(client, cursor));
      if (page === null) return null;
      for (const raw of page.messages) {
        const message = slackMessageSchema.safeParse(raw);
        if (message.success) messages.push(message.data);
        else console.error(`Skipped a ${method} message: ${issuesOf(message.error).join(", ")}`);
      }
      const next = continueHistory(page, used);
      if (next.kind === "done") return messages;
      if (next.kind === "incomplete") {
        throw new Unfinished(`Slack's ${method} pages ended with ${next.reason}.`);
      }
      cursor = next.cursor;
      used.add(cursor);
    }
  }

  /** Slack's answer once its rate limits allow, or null when it shut the bot out of the channel. */
  async function ask<Result>(
    method: string,
    channelId: string,
    run: (client: WebClient) => Promise<Result>,
  ): Promise<Result | null> {
    while (true) {
      if (signal.aborted) throw new Unfinished("The bridge is stopping.");
      const call = await bot.call(method, run);
      switch (call.kind) {
        case "ok":
          return call.result;
        case "rate_limited":
          await sleep(call.until - now(), signal);
          continue;
        case "error": {
          const reason = channelFailureReason(call.error);
          if (reason === null) throw new Unfinished(`Slack refused ${method} with ${call.error}.`);
          const suspended = await database.write((transaction) =>
            suspendChannelLinks(transaction, channelId, reason, now()),
          );
          if (suspended.length > 0) onChange();
          return null;
        }
        case "auth_failed":
          // Only the operator can replace a token Slack rejected, so nothing asks again until the
          // bridge restarts, and status says why.
          stopping.abort();
          throw new Unfinished(`Slack refused ${method} with ${call.error}.`);
        case "unknown":
          throw new Unfinished(`Slack didn't answer ${method}: ${call.detail}.`);
      }
    }
  }

  function fail(error: unknown) {
    if (signal.aborted) return;
    stopping.abort();
    clearTimeout(timer);
    console.error("Stopped catching up with Slack:", error);
    onError(error);
  }

  return {
    poke,
    problem: () => problem,
    async stop() {
      stopping.abort();
      // A run in progress can arm the next as it ends, so its timer is cleared once it's done.
      await running;
      clearTimeout(timer);
    },
  };
}
