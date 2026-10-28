import { acksInTime, lifecycleAction, type SlackDelivery } from "@activity/model/receiver";
import { SerialTaskQueue } from "@/shared/serialTaskQueue";
import type { BridgeDatabase } from "@bridge/server/database";
import { recordUninstall, suspendChannelLinks } from "@links/server/lifecycle";
import type { EventCallback } from "@slackapi/model/envelopes";
import { isForInstallation, readSlackEvent } from "@slackapi/model/events";
import type { Installation } from "@slackapi/model/installation";
import { normalizeMessageEvent, type SlackMessageEventPayload } from "@slackapi/model/messages";
import { markConnected, markDisconnected, readInstallation } from "@slackapi/server/installation";
import { readBotUserIds } from "@slackapi/server/users";
import { ingestMessageEvent } from "./ingest";

// The receiver.
//
// Deliveries are handled one at a time in the order they arrived. Each one commits everything it
// changes in one transaction, and only then is its envelope acked, and only while Slack still
// waits, so a delivery is never acked unless it's stored. A delivery that fails to commit isn't
// acked, and nothing after it is handled, so Slack sends it again to a bridge that starts afresh.
// A hello and a lost connection take their places in the same order.

export interface SlackReceiver {
  /**
   * Handles a delivery that arrived at `arrivedAt` after every delivery received before it, and
   * acks its envelope once what it changed has committed in time. `ack` never throws.
   */
  receive(
    delivery: SlackDelivery,
    arrivedAt: number,
    ack: (envelopeId: string) => void,
  ): Promise<void>;
  /** Notes that Slack said hello at `helloAt`, after every delivery received before the hello. */
  connected(helloAt: number): Promise<void>;
  /** Notes that the connection was found lost at `at`. */
  disconnected(at: number): Promise<void>;
  /** Stops once the delivery in hand is handled. */
  stop(): Promise<void>;
}

export type SlackReceiverOptions = {
  /** Called after a delivery changed a link or request. */
  onChange?: () => void;
  /** Called after a delivery uninstalled the app and the purge committed. */
  onUninstalled?: () => void;
  /** Called when the receiver stops on an error, such as storage failing. */
  onError?: (error: unknown) => void;
  now?: () => number;
};

/** What a delivery did, which decides what follows its commit. */
type Taken = { changed: boolean; uninstalled?: boolean };

const unchanged: Taken = { changed: false };

export function startSlackReceiver(
  database: BridgeDatabase,
  {
    onChange = () => {},
    onUninstalled = () => {},
    onError = () => {},
    now = Date.now,
  }: SlackReceiverOptions = {},
): SlackReceiver {
  const queue = new SerialTaskQueue();
  let stopped = false;

  async function handle(
    delivery: SlackDelivery,
    arrivedAt: number,
    ack: (envelopeId: string) => void,
  ) {
    if (stopped) return;
    let taken: Taken;
    try {
      taken = await database.write((transaction) => take(transaction, delivery, now()));
    } catch (error) {
      fail(error);
      return;
    }
    if (delivery.envelopeId !== null) {
      if (acksInTime(arrivedAt, now())) ack(delivery.envelopeId);
      else
        console.error("Stored a delivery from Slack too late to ack it, so Slack will resend it.");
    }
    if (taken.changed) onChange();
    if (taken.uninstalled) onUninstalled();
  }

  async function note(mark: (transaction: Bun.SQL, at: number) => Promise<void>, at: number) {
    if (stopped) return;
    try {
      await database.write((transaction) => mark(transaction, at));
    } catch (error) {
      fail(error);
    }
  }

  function fail(error: unknown) {
    stopped = true;
    console.error("Stopped receiving from Slack:", error);
    onError(error);
  }

  return {
    receive: (delivery, arrivedAt, ack) => queue.enqueue(() => handle(delivery, arrivedAt, ack)),
    connected: (helloAt) => queue.enqueue(() => note(markConnected, helloAt)),
    disconnected: (at) => queue.enqueue(() => note(markDisconnected, at)),
    async stop() {
      stopped = true;
      await queue.waitForPending();
    },
  };
}

/**
 * Takes a delivery. Nothing is taken before the bridge knows who it is, or once the app is
 * uninstalled. Taking a redelivery again changes nothing.
 */
async function take(transaction: Bun.SQL, delivery: SlackDelivery, now: number): Promise<Taken> {
  const installation = await readInstallation(transaction);
  if (installation === null || installation.status === "uninstalled") return unchanged;
  switch (delivery.kind) {
    case "event":
      return takeEvent(transaction, delivery.callback, installation, now);
    case "rate_limited":
      if (delivery.appId === installation.appId && delivery.teamId === installation.teamId) {
        console.error("Slack held events back for a minute, so the bridge may have missed some.");
      }
      return unchanged;
    case "malformed":
      return takeMalformed("a frame", delivery.issues);
    case "other":
      return unchanged;
  }
}

async function takeEvent(
  transaction: Bun.SQL,
  callback: EventCallback,
  installation: Installation,
  now: number,
): Promise<Taken> {
  if (!isForInstallation(callback, installation)) return unchanged;
  const event = readSlackEvent(callback.event);
  if (event.kind === "malformed") {
    return takeMalformed(`an event of type ${callback.event.type}`, event.issues);
  }
  const taken =
    event.kind === "message"
      ? await takeMessage(transaction, event.payload, installation, now)
      : unchanged;
  const action = lifecycleAction(event, installation.botUserId);
  switch (action?.kind) {
    case undefined:
      return taken;
    case "suspend": {
      const suspended = await suspendChannelLinks(
        transaction,
        action.channelId,
        action.reason,
        now,
      );
      return { changed: taken.changed || suspended.length > 0 };
    }
    case "uninstall":
      await recordUninstall(transaction);
      return { changed: true, uninstalled: true };
  }
}

async function takeMessage(
  transaction: Bun.SQL,
  payload: SlackMessageEventPayload,
  installation: Installation,
  now: number,
): Promise<Taken> {
  const botUserIds = await readBotUserIds(transaction);
  const event = normalizeMessageEvent(payload, {
    botUserId: installation.botUserId,
    botId: installation.botId,
    isBotUser: (userId) => botUserIds.has(userId),
  });
  return { changed: await ingestMessageEvent(transaction, event, now) };
}

/** Logs what couldn't be read, by its issue codes and paths only. */
function takeMalformed(what: string, issues: string[]): Taken {
  console.error(`Couldn't read ${what} from Slack: ${issues.join(", ")}`);
  return unchanged;
}
