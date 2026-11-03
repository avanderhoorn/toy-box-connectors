import type { BridgeDatabase } from "@bridge/server/database";
import { readRequest, type StoredRequest } from "@requests/server/database";
import type { BotClient } from "@slackapi/server/botClient";
import { log as bridgeLog, type Log } from "@/shared/log";
import { reactionChanges, type ReactionChange, type Standing } from "../model/reactions";
import { readDueReconciliations, readReadyOutbox } from "./database";
import { createFileDeletion } from "./deletions";
import { readDueDeletions } from "./files";
import { createPostDelivery, type PostStep } from "./posts";
import { createReconciliation } from "./reconcile";

/** A request, as far as its message in Slack goes. */
export type MarkedRequest = Pick<StoredRequest, "channelId" | "sourceTs">;
/** A call the worker owes Slack on a request's message. */
type Owed = MarkedRequest & ReactionChange;
/** How many times Slack may leave a reaction call unanswered before the worker gives it up. */
const UNANSWERED_LIMIT = 3;
export interface OutboxWorker {
  poke(): void;
  /**
   * Brings the reactions on the requests' messages to `standing`, once Slack is connected. They're
   * best effort, kept in memory, and never hold up a post.
   */
  mark(requests: readonly MarkedRequest[], standing: Standing): void;
  stop(): Promise<void>;
}

export function startOutboxWorker(
  database: BridgeDatabase,
  bot: BotClient,
  {
    ready,
    onChange,
    onError,
    now = Date.now,
    log = bridgeLog,
  }: {
    ready: () => boolean;
    onChange: () => void;
    onError: (error: unknown) => void;
    now?: () => number;
    /** Where the worker says why it stopped, the bridge's log unless set. */
    log?: Log;
  },
): OutboxWorker {
  const posts = createPostDelivery(database, bot, { now });
  const checks = createReconciliation(database, bot, { now });
  const deletions = createFileDeletion(database, bot, { now, log });
  const owed: Owed[] = [];
  let unanswered = 0;
  let stopped = false;
  let pending = false;
  let running = Promise.resolve();

  function poke() {
    if (stopped || pending) return;
    pending = true;
    running = running.then(pass).catch((error) => {
      stopped = true;
      clearInterval(timer);
      log("Stopped delivering Slack posts:", error);
      onError(error);
    });
  }

  async function pass() {
    pending = false;
    if (stopped || !ready()) return;
    const jobs = await database.read(async (sql) => [
      ...(await readDueReconciliations(sql, now())),
      ...(await readReadyOutbox(sql, now())),
    ]);
    for (const item of jobs) {
      if (stopped || !ready()) return;
      const step = await (item.state === "queued"
        ? posts.post(item.id)
        : checks.reconcile(item.id));
      onChange();
      const answered = await answeredRequest(step);
      if (answered) owe([answered], "answered");
    }
    while (owed.length) {
      if (stopped || !ready()) return;
      const { change, name, channelId, sourceTs } = owed[0]!;
      const call = await bot.call(`reactions.${change}`, (client) =>
        client.reactions[change]({ channel: channelId, timestamp: sourceTs, name }),
      );
      // What Slack holds back stays owed, in order, so half a swap never strands a reaction, and
      // it doesn't hold up posts. One Slack won't answer is given up, so it can't block the rest.
      if (call.kind === "rate_limited" || call.kind === "auth_failed") break;
      if (call.kind === "unknown" && ++unanswered < UNANSWERED_LIMIT) break;
      unanswered = 0;
      owed.shift();
    }
    for (const owed of await database.read((sql) => readDueDeletions(sql, now()))) {
      if (stopped || !ready()) return;
      // A Slack that keeps one file, or doesn't answer, costs a pass one call, not one per file.
      if ((await deletions.settle(owed)).kind === "kept") break;
    }
  }

  /** The request a reply just proved posted answered, if it still exists. */
  async function answeredRequest(step: PostStep): Promise<MarkedRequest | null> {
    if (step.kind !== "settled") return null;
    const { kind, state, requestId } = step.item;
    if (kind !== "reply" || state !== "sent" || requestId === null) return null;
    return database.read((sql) => readRequest(sql, requestId));
  }

  function owe(requests: readonly MarkedRequest[], standing: Standing) {
    for (const { channelId, sourceTs } of requests)
      for (const change of reactionChanges(standing)) owed.push({ channelId, sourceTs, ...change });
  }

  const timer = setInterval(poke, 1000);
  poke();
  return {
    poke,
    mark(requests, standing) {
      if (stopped) return;
      owe(requests, standing);
      poke();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
