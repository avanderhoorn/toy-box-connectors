import type { BridgeDatabase } from "@bridge/server/database";
import { readRequest, type StoredRequest } from "@requests/server/database";
import type { BotClient } from "@slackapi/server/botClient";
import { log as bridgeLog, type Log } from "@/shared/log";
import { readDueReconciliations, readReadyOutbox } from "./database";
import { createFileDeletion } from "./deletions";
import { readDueDeletions } from "./files";
import { createPostDelivery, type PostStep } from "./posts";
import { createReconciliation } from "./reconcile";

type SeenRequest = Pick<StoredRequest, "channelId" | "sourceTs">;
/** The bot's 👀 on a request's message, put on once its lead is woken or reads it and taken off once its answer posts. */
type Eyes = SeenRequest & { change: "add" | "remove" };
export interface OutboxWorker {
  poke(): void;
  acknowledge(requests: readonly SeenRequest[]): void;
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
  const eyes: Eyes[] = [];
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
      if (answered) eyes.push({ change: "remove", ...answered });
    }
    for (const { change, channelId, sourceTs } of eyes.splice(0)) {
      if (stopped || !ready()) return;
      const reaction = { channel: channelId, timestamp: sourceTs, name: "eyes" };
      const call = await bot.call(`reactions.${change}`, (client) =>
        client.reactions[change](reaction),
      );
      // An unavailable method should not hold up posts for a best-effort batch.
      if (call.kind !== "ok" && call.kind !== "error") break;
    }
    for (const owed of await database.read((sql) => readDueDeletions(sql, now()))) {
      if (stopped || !ready()) return;
      // A Slack that keeps one file, or doesn't answer, costs a pass one call, not one per file.
      if ((await deletions.settle(owed)).kind === "kept") break;
    }
  }

  /** The request a reply just proved posted answered, if it still exists. */
  async function answeredRequest(step: PostStep): Promise<SeenRequest | null> {
    if (step.kind !== "settled") return null;
    const { kind, state, requestId } = step.item;
    if (kind !== "reply" || state !== "sent" || requestId === null) return null;
    return database.read((sql) => readRequest(sql, requestId));
  }

  const timer = setInterval(poke, 1000);
  poke();
  return {
    poke,
    acknowledge(requests) {
      if (stopped || !ready()) return;
      for (const { channelId, sourceTs } of requests)
        eyes.push({ change: "add", channelId, sourceTs });
      poke();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
