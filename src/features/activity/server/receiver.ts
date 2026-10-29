import { acksInTime, lifecycleAction, type SlackDelivery } from "@activity/model/receiver";
import { log as bridgeLog, type Log } from "@/shared/log";
import { SerialTaskQueue } from "@/shared/serialTaskQueue";
import type { BridgeDatabase } from "@bridge/server/database";
import { recordUninstall, suspendChannelLinks } from "@links/server/lifecycle";
import type { EventCallback } from "@slackapi/model/envelopes";
import { isForInstallation, readSlackEvent } from "@slackapi/model/events";
import type { Installation } from "@slackapi/model/installation";
import { normalizeMessageEvent, type SlackMessageEventPayload } from "@slackapi/model/messages";
import { readInstallation } from "@slackapi/server/installation";
import { noteGap, noteHello } from "./catchUp";
import { ingestMessageEvent } from "./ingest";

// The receiver.
//
// Deliveries are handled one at a time in the order they arrived. Each one commits everything it
// changes in one transaction, and only then is its envelope acked, and only while Slack still
// waits, so a delivery is never acked unless it's stored. A delivery that fails to commit isn't
// acked, and nothing after it is handled, so Slack sends it again to a bridge that starts afresh.
// A hello takes its place in the same order. It notes that the bridge may have missed anything
// since the last one, as a minute Slack held events back and a delivery the bridge can't read do,
// and catch-up reads what was missed from Slack's history.

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
  /** Stops once the delivery in hand is handled. */
  stop(): Promise<void>;
}

export type SlackReceiverOptions = {
  /** Called after a delivery changed a link or request. */
  onChange?: () => void;
  /** Called after a hello or delivery noted that the bridge may have missed events. */
  onMissed?: () => void;
  /** Called after a delivery uninstalled the app and the purge committed. */
  onUninstalled?: () => void;
  /** Called when the receiver stops on an error, such as storage failing. */
  onError?: (error: unknown) => void;
  now?: () => number;
  /** Where the receiver says what it's doing, the bridge's log unless set. */
  log?: Log;
};

/** What a delivery did, which decides what follows its commit. */
type Taken = { changed: boolean; missed?: boolean; uninstalled?: boolean };

const unchanged: Taken = { changed: false };
const missed: Taken = { changed: false, missed: true };

export function startSlackReceiver(
  database: BridgeDatabase,
  {
    onChange = () => {},
    onMissed = () => {},
    onUninstalled = () => {},
    onError = () => {},
    now = Date.now,
    log = bridgeLog,
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
      taken = await database.write((transaction) => take(transaction, delivery, now(), log));
    } catch (error) {
      fail(error);
      return;
    }
    if (delivery.envelopeId !== null) {
      if (acksInTime(arrivedAt, now())) ack(delivery.envelopeId);
      else log("Stored a delivery from Slack too late to ack it, so Slack will resend it.");
    }
    if (taken.changed) onChange();
    if (taken.missed) onMissed();
    if (taken.uninstalled) onUninstalled();
  }

  async function hello(helloAt: number) {
    if (stopped) return;
    try {
      await database.write((transaction) => noteHello(transaction, helloAt));
    } catch (error) {
      fail(error);
      return;
    }
    onMissed();
  }

  function fail(error: unknown) {
    stopped = true;
    log("Stopped receiving from Slack:", error);
    onError(error);
  }

  return {
    receive: (delivery, arrivedAt, ack) => queue.enqueue(() => handle(delivery, arrivedAt, ack)),
    connected: (helloAt) => queue.enqueue(() => hello(helloAt)),
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
async function take(
  transaction: Bun.SQL,
  delivery: SlackDelivery,
  now: number,
  log: Log,
): Promise<Taken> {
  const installation = await readInstallation(transaction);
  if (installation === null || installation.status === "uninstalled") return unchanged;
  switch (delivery.kind) {
    case "event":
      return takeEvent(transaction, delivery.callback, installation, now, log);
    case "rate_limited":
      await noteGap(transaction, now, now + 60_000);
      log("Slack held events back for a minute, so the bridge will catch up on them.");
      return missed;
    case "malformed":
      return takeMalformed(transaction, "a frame", delivery.issues, now, log);
    case "other":
      return unchanged;
  }
}

async function takeEvent(
  transaction: Bun.SQL,
  callback: EventCallback,
  installation: Installation,
  now: number,
  log: Log,
): Promise<Taken> {
  if (!isForInstallation(callback, installation)) return unchanged;
  const event = readSlackEvent(callback.event);
  if (event.kind === "malformed") {
    const what = `an event of type ${callback.event.type}`;
    return takeMalformed(transaction, what, event.issues, now, log);
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
  const event = normalizeMessageEvent(payload, installation);
  return { changed: await ingestMessageEvent(transaction, event, now) };
}

/** Notes that the bridge missed what it couldn't read, logged by its issue codes and paths only. */
async function takeMalformed(
  transaction: Bun.SQL,
  what: string,
  issues: string[],
  now: number,
  log: Log,
): Promise<Taken> {
  await noteGap(transaction, now, now);
  log(`Couldn't read ${what} from Slack, so the bridge will catch up on it: ${issues.join(", ")}`);
  return missed;
}
