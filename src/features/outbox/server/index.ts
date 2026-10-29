import type { BridgeDatabase } from "@bridge/server/database";
import type { StoredRequest } from "@requests/server/database";
import type { BotClient } from "@slackapi/server/botClient";
import { log } from "@/shared/log";
import { readDueReconciliations, readReadyOutbox } from "./database";
import { createPostDelivery } from "./posts";
import { createReconciliation } from "./reconcile";

type SeenRequest = Pick<StoredRequest, "channelId" | "sourceTs">;
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
  }: {
    ready: () => boolean;
    onChange: () => void;
    onError: (error: unknown) => void;
    now?: () => number;
  },
): OutboxWorker {
  const posts = createPostDelivery(database, bot, { now });
  const checks = createReconciliation(database, bot, { now });
  const eyes: SeenRequest[] = [];
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
      await (item.state === "queued" ? posts.post(item.id) : checks.reconcile(item.id));
      onChange();
    }
    for (const request of eyes.splice(0)) {
      if (stopped || !ready()) return;
      const call = await bot.call("reactions.add", (client) =>
        client.reactions.add({
          channel: request.channelId,
          timestamp: request.sourceTs,
          name: "eyes",
        }),
      );
      // An unavailable method should not hold up posts for a best-effort batch.
      if (call.kind !== "ok" && call.kind !== "error") break;
    }
  }

  const timer = setInterval(poke, 1000);
  poke();
  return {
    poke,
    acknowledge(requests) {
      if (stopped || !ready()) return;
      eyes.push(...requests);
      poke();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
