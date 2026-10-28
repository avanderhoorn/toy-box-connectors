import { interruptionGap, rateLimitedGap } from "@activity/model/gaps";
import {
  acksInTime,
  lifecycleAction,
  receiptKey,
  receiptType,
  type LifecycleAction,
  type SlackDelivery,
} from "@activity/model/receiver";
import { SerialTaskQueue } from "@/shared/serialTaskQueue";
import type { BridgeDatabase } from "@bridge/server/database";
import { takeClick } from "@links/server/approvals";
import { changeChannelId, recordUninstall, suspendChannelLinks } from "@links/server/lifecycle";
import { moveRequestChannel } from "@requests/server/database";
import type { EventCallback, MalformedHint } from "@slackapi/model/envelopes";
import { isForInstallation, readSlackEvent } from "@slackapi/model/events";
import type { Installation } from "@slackapi/model/installation";
import { normalizeMessageEvent, type SlackMessageEventPayload } from "@slackapi/model/messages";
import { currentChannelId, invalidateChannelInfo } from "@slackapi/server/channels";
import { readInstallation } from "@slackapi/server/installation";
import { hasReceipt, recordReceipt, type ReceiptDisposition } from "@slackapi/server/receipts";
import { readBotUserIds } from "@slackapi/server/users";
import { recordChannelGaps, recordConnect, recordDisconnect } from "./coverage";
import { forgetFile, removeLocalCopies } from "./files";
import { ingestMessageEvent } from "./ingest";
import { moveLedgerChannel } from "./ledger";

// The receiver.
//
// Deliveries are handled one at a time in the order they arrived. Each one commits everything it
// changes with its receipt in one transaction, and only then is its envelope acked, and only while
// Slack still waits, so a delivery is never acked unless it's stored. A delivery that fails to
// commit isn't acked, and nothing after it is handled, so Slack sends it again to a bridge that
// starts afresh. Local copies of files whose rows a delivery deleted are removed after the commit.
//
// While Slack rejects the bot token, a channel's lifecycle, deleted and withdrawn messages, deleted
// files, gaps and clicks are still taken, because repair can't find any of them later. What's
// posted or edited meanwhile is left for the repair that follows recovery.
//
// A hello takes its place in the same order, so the gap it records ends before anything the new
// connection delivers is stored, and no receipt from it can shorten the gap.

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
  /**
   * Records what the bridge may have missed before Slack said hello at `helloAt`, after every
   * delivery received before the hello. The first hello follows startup, and each later one a
   * lost connection.
   */
  connected(helloAt: number): Promise<void>;
  /** Holds every pending request's replies, because the connection was found lost at `at`. */
  disconnected(at: number): Promise<void>;
  /** Stops once the delivery in hand is handled. */
  stop(): Promise<void>;
}

export type SlackReceiverOptions = {
  /** The folder local copies of files are kept in. */
  filesFolder: string;
  /** Called after a delivery changed a link, request, approval or channel's stored facts. */
  onChange?: () => void;
  /** Called after a delivery uninstalled the app and the purge committed. */
  onUninstalled?: () => void;
  /** Called when the receiver stops on an error, such as storage failing. */
  onError?: (error: unknown) => void;
  now?: () => number;
};

/** What a delivery did, which decides its receipt and what follows its commit. */
type Taken = {
  disposition: ReceiptDisposition;
  changed?: boolean;
  /** Local copies of files whose rows are gone. */
  purged?: string[];
  /** The app was uninstalled, which purged receipts with everything else. */
  uninstalled?: boolean;
};

const ignored: Taken = { disposition: "ignored" };

export function startSlackReceiver(
  database: BridgeDatabase,
  {
    filesFolder,
    onChange = () => {},
    onUninstalled = () => {},
    onError = () => {},
    now = Date.now,
  }: SlackReceiverOptions,
): SlackReceiver {
  const queue = new SerialTaskQueue();
  let stopped = false;
  let interruption: "startup" | "disconnect" = "startup";

  async function handle(
    delivery: SlackDelivery,
    arrivedAt: number,
    ack: (envelopeId: string) => void,
  ) {
    if (stopped) return;
    let taken: Taken | null;
    try {
      const at = now();
      taken = await database.write((transaction) => take(transaction, delivery, arrivedAt, at));
    } catch (error) {
      fail(error);
      return;
    }
    if (delivery.envelopeId !== null) {
      if (acksInTime(arrivedAt, now())) ack(delivery.envelopeId);
      else
        console.error("Stored a delivery from Slack too late to ack it, so Slack will resend it.");
    }
    if (taken === null) return;
    if (taken.purged?.length) await removeLocalCopies(filesFolder, taken.purged);
    if (taken.changed) onChange();
    if (taken.uninstalled) onUninstalled();
  }

  async function connect(helloAt: number) {
    if (stopped) return;
    try {
      await database.write((transaction) =>
        recordConnect(transaction, helloAt, interruption, now()),
      );
      interruption = "disconnect";
    } catch (error) {
      fail(error);
    }
  }

  async function disconnect(at: number) {
    if (stopped) return;
    try {
      await database.write((transaction) => recordDisconnect(transaction, at));
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
    connected: (helloAt) => queue.enqueue(() => connect(helloAt)),
    disconnected: (at) => queue.enqueue(() => disconnect(at)),
    async stop() {
      stopped = true;
      await queue.waitForPending();
    },
  };
}

/**
 * Takes a delivery once, with its receipt. Null when there's nothing to take: the bridge doesn't
 * know who it is yet, the app is uninstalled, or the delivery was received already.
 */
async function take(
  transaction: Bun.SQL,
  delivery: SlackDelivery,
  arrivedAt: number,
  now: number,
): Promise<Taken | null> {
  const installation = await readInstallation(transaction);
  if (installation === null || installation.status === "uninstalled") return null;
  const key = receiptKey(delivery);
  if (key !== null && (await hasReceipt(transaction, key))) return null;

  const context = { installation, arrivedAt, now };
  const taken = await takeDelivery(transaction, delivery, context);
  if (key !== null && !taken.uninstalled) {
    const type = receiptType(delivery);
    await recordReceipt(transaction, {
      key,
      type,
      receivedAt: arrivedAt,
      disposition: taken.disposition,
    });
  }
  return taken;
}

type TakeContext = { installation: Installation; arrivedAt: number; now: number };

async function takeDelivery(
  transaction: Bun.SQL,
  delivery: SlackDelivery,
  context: TakeContext,
): Promise<Taken> {
  switch (delivery.kind) {
    case "event":
      return takeEvent(transaction, delivery.callback, context);
    case "rate_limited":
      return takeRateLimit(transaction, delivery, context);
    case "interactive":
      return takeInteraction(transaction, delivery.payload, context.now);
    case "malformed":
      return takeMalformed(transaction, delivery.hint, delivery.issues, "a frame", context);
    case "other":
      return ignored;
  }
}

async function takeEvent(
  transaction: Bun.SQL,
  callback: EventCallback,
  context: TakeContext,
): Promise<Taken> {
  const { installation } = context;
  if (!isForInstallation(callback, installation)) return { disposition: "foreign" };
  const event = readSlackEvent(callback.event);
  switch (event.kind) {
    case "malformed": {
      const hint = { channelId: event.channelId, eventTime: callback.eventTime };
      const what = `an event of type ${callback.event.type}`;
      return takeMalformed(transaction, hint, event.issues, what, context);
    }
    case "message": {
      const action = lifecycleAction(event, installation.botUserId);
      const message = await takeMessage(transaction, event.payload, context);
      if (action === null) return message;
      await takeLifecycle(transaction, action, callback.eventTime, context);
      return { ...message, disposition: "applied", changed: true };
    }
    case "file_deleted": {
      const purged = await forgetFile(transaction, event.fileId);
      return purged === null ? ignored : { disposition: "applied", purged };
    }
    case "other":
      return ignored;
    default: {
      const action = lifecycleAction(event, installation.botUserId);
      if (action === null) return ignored;
      return takeLifecycle(transaction, action, callback.eventTime, context);
    }
  }
}

async function takeMessage(
  transaction: Bun.SQL,
  payload: SlackMessageEventPayload,
  { installation, now }: TakeContext,
): Promise<Taken> {
  const botUserIds = await readBotUserIds(transaction);
  const event = normalizeMessageEvent(payload, {
    botUserId: installation.botUserId,
    botId: installation.botId,
    isBotUser: (userId) => botUserIds.has(userId),
  });
  // Repair finds what was posted or edited while Slack rejected the token, but never a delete, and
  // never a withdrawal of a message older than the gap.
  const removes = event.kind === "deleted" || event.kind === "withdrawn";
  if (installation.status !== "active" && !removes) return ignored;

  const ingested = await ingestMessageEvent(transaction, event, {
    botUserId: installation.botUserId,
    ownerUserId: installation.ownerUserId,
    late: false,
    now,
  });
  switch (ingested.kind) {
    case "claim":
      return { disposition: "claim", changed: ingested.changed };
    case "unlinked":
      return { disposition: "unlinked" };
    case "stored":
      return { disposition: "applied", changed: ingested.requestsChanged, purged: ingested.purged };
  }
}

/**
 * Acts on what an event means for the links on its channel. An event that names an ID Slack moved
 * the channel from is about the channel at its current ID, but a move is taken as Slack named it,
 * so a channel that moves back follows.
 */
async function takeLifecycle(
  transaction: Bun.SQL,
  action: LifecycleAction,
  eventTime: number,
  { arrivedAt, now }: TakeContext,
): Promise<Taken> {
  switch (action.kind) {
    case "invalidate": {
      const channelId = await currentChannelId(transaction, action.channelId);
      await invalidateChannelInfo(transaction, channelId, now);
      break;
    }
    case "suspend": {
      const channelId = await currentChannelId(transaction, action.channelId);
      await suspendChannelLinks(transaction, channelId, action.reason, now);
      break;
    }
    case "move": {
      const { oldChannelId, newChannelId } = action;
      await changeChannelId(transaction, oldChannelId, newChannelId, now);
      await moveLedgerChannel(transaction, oldChannelId, newChannelId);
      await moveRequestChannel(transaction, oldChannelId, newChannelId);
      // Events under the new ID that arrived before this one found no link watching it.
      const since = happenedAt(eventTime, arrivedAt);
      await recordChannelGaps(transaction, newChannelId, "moved", now, (linkedAtTs) =>
        interruptionGap(since, arrivedAt, linkedAtTs),
      );
      break;
    }
    case "uninstall":
      return {
        disposition: "applied",
        changed: true,
        purged: await recordUninstall(transaction, now),
        uninstalled: true,
      };
  }
  return { disposition: "applied", changed: true };
}

/** Records the minute Slack held events back as a gap in every linked channel. */
async function takeRateLimit(
  transaction: Bun.SQL,
  delivery: Extract<SlackDelivery, { kind: "rate_limited" }>,
  { installation, now }: TakeContext,
): Promise<Taken> {
  if (delivery.appId !== installation.appId || delivery.teamId !== installation.teamId) {
    return { disposition: "foreign" };
  }
  console.error("Slack held events back for a minute, so repair will read that minute.");
  await recordChannelGaps(transaction, null, "rate_limited", now, (linkedAtTs) =>
    rateLimitedGap(delivery.minute, linkedAtTs),
  );
  return { disposition: "rate_limited" };
}

async function takeInteraction(
  transaction: Bun.SQL,
  payload: unknown,
  now: number,
): Promise<Taken> {
  const click = await takeClick(transaction, payload, now);
  return { disposition: "interactive", changed: click.kind === "settled" };
}

/**
 * Logs what couldn't be read, by its issue codes and paths only, and records a gap from when it
 * happened in the channel it names, or in every linked channel when it names none.
 */
async function takeMalformed(
  transaction: Bun.SQL,
  hint: MalformedHint,
  issues: string[],
  what: string,
  { arrivedAt, now }: TakeContext,
): Promise<Taken> {
  console.error(
    `Couldn't read ${what} from Slack, so repair will read around it: ${issues.join(", ")}`,
  );
  const since = hint.eventTime === null ? arrivedAt : happenedAt(hint.eventTime, arrivedAt);
  await recordChannelGaps(transaction, hint.channelId, "malformed", now, (linkedAtTs) =>
    interruptionGap(since, arrivedAt, linkedAtTs),
  );
  return { disposition: "malformed" };
}

/**
 * When an event Slack timed at `eventTime` epoch seconds happened, by this Mac's clock. It can't
 * have happened after it arrived, so a later time is only the two clocks disagreeing.
 */
function happenedAt(eventTime: number, arrivedAt: number): number {
  return Math.min(eventTime * 1000, arrivedAt);
}
