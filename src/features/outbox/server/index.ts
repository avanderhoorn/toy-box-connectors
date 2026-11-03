import type { BridgeDatabase } from "@bridge/server/database";
import type { BotClient } from "@slackapi/server/botClient";
import { log as bridgeLog, type Log } from "@/shared/log";
import { readDueReconciliations, readReadyOutbox } from "./database";
import { createFileDeletion } from "./deletions";
import { readDueDisplays } from "./displays";
import { readDueDeletions } from "./files";
import { createPostDelivery } from "./posts";
import { createReactions } from "./reactions";
import { createReconciliation } from "./reconcile";

export interface OutboxWorker {
  poke(): void;
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
  const reactions = createReactions(database, bot, { now, log });
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
      if (item.state === "queued") await posts.post(item.id);
      else await checks.reconcile(item.id);
      onChange();
    }
    for (const owed of await database.read((sql) => readDueDisplays(sql, now()))) {
      if (stopped || !ready()) return;
      // A Slack that holds one back, or doesn't answer, costs a pass one call, not one per message,
      // and never holds up a post, which goes first.
      if ((await reactions.settle(owed)).held) break;
    }
    for (const owed of await database.read((sql) => readDueDeletions(sql, now()))) {
      if (stopped || !ready()) return;
      // A Slack that keeps one file, or doesn't answer, costs a pass one call, not one per file.
      if ((await deletions.settle(owed)).kind === "kept") break;
    }
  }

  const timer = setInterval(poke, 1000);
  poke();
  return {
    poke,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
