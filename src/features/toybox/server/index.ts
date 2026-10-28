// The Toy Box client.
//
// The bridge follows each linked channel's event stream for as long as the link exists. A follower
// commits each frame before it reads the next, so the stored revision never runs ahead of what the
// bridge applied, and a reconnect resumes after it or takes Toy Box's snapshot. Toy Box keeps its
// own wakes in memory, so the wake scheduler decides from what this client stored and runs
// routines through it. The client also keeps Toy Box's catalog, which says who a caller is, until
// a linked channel's members may have changed.

import type { BridgeDatabase } from "@bridge/server/database";
import { suspendLink } from "@links/server/status";
import { cancelLinkRequests, releaseHolds } from "@requests/server/lifecycle";
import type { RoutineRunOutcome, ToyBoxCatalog } from "@toybox/model";
import {
  observeChannelFrame,
  parseChannelFrame,
  reduceToyBoxStream,
  UNREAD_TOYBOX_STREAM,
  type ChannelObservation,
  type ToyBoxStream,
} from "@toybox/model/stream";
import { defaultWakeTimings, retryDelay, type ToyBoxView, type WakeTimings } from "@wakes/model";
import { SerialTaskQueue } from "@/shared/serialTaskQueue";
import { sleep } from "@/shared/sleep";
import { fetchToyBoxCatalog, readChannelStream, runToyBoxRoutine } from "./api";
import {
  readFollowedLinks,
  readToyBoxStream,
  recordLinkRoutines,
  writeToyBoxStream,
  type FollowedLink,
} from "./database";
import { readServerSentEvents, type ServerSentEvent } from "./sse";

export interface ToyBoxClient {
  /** What the bridge knows of a linked channel's Toy Box side right now. */
  view(channelId: string): ToyBoxView;
  /**
   * The channels and members the bridge last read, or null when it hasn't read them since a
   * linked channel's members may have changed.
   */
  catalog(): ToyBoxCatalog | null;
  /** Reads the catalog again, sharing a read already on its way unless members changed since. */
  loadCatalog(): Promise<ToyBoxCatalog>;
  /** Runs one of the channel's routines, which wakes its lead. */
  runRoutine(channelId: string, routineId: string): Promise<RoutineRunOutcome>;
  /** Follows every linked channel, and stops following channels that are no longer linked. */
  followLinks(): Promise<void>;
  /** Stops following once every frame being recorded has committed. */
  stop(): Promise<void>;
}

export type ToyBoxClientOptions = {
  /** Toy Box's loopback origin. */
  origin: URL;
  /** Called once a stream changed what a wake decision for these links reads. */
  onChange?: (linkIds: readonly string[]) => void;
  /** Called when a follower stops on an error that retrying can't fix, such as a storage error. */
  onError?: (error: unknown) => void;
  now?: () => number;
  /** A stream that never came up retries on the wake retry backoff. */
  timings?: WakeTimings;
  /** How long a stream that was up waits to reconnect, which is Toy Box's retry hint. */
  reconnectDelay?: number;
  /** How long a stream may stay quiet. Toy Box sends a keepalive every 5 seconds. */
  idleTimeout?: number;
};

type Follower = {
  link: FollowedLink;
  stream: ToyBoxStream;
  connected: boolean;
  abort: AbortController;
  done: Promise<void>;
};

type Received = "established" | "deleted" | undefined;

/** Starts a client that follows nothing until `followLinks`. */
export function startToyBoxClient(
  database: BridgeDatabase,
  {
    origin,
    onChange = () => {},
    onError = () => {},
    now = Date.now,
    timings = defaultWakeTimings,
    reconnectDelay = 1_000,
    idleTimeout = 30_000,
  }: ToyBoxClientOptions,
): ToyBoxClient {
  const followers = new Map<string, Follower>();
  // Toy Box never reuses a channel ID, so a channel it deleted stays deleted.
  const deleted = new Set<string>();
  const reconciling = new SerialTaskQueue();
  let stopped = false;
  // A read that members changed during still answers whoever asked, but isn't kept.
  let catalog: ToyBoxCatalog | null = null;
  let memberChanges = 0;
  let catalogRead: { memberChanges: number; read: Promise<ToyBoxCatalog> } | undefined;

  function follow(link: FollowedLink) {
    const follower: Follower = {
      link,
      stream: UNREAD_TOYBOX_STREAM,
      connected: false,
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    followers.set(link.channelId, follower);
    follower.done = run(follower)
      .catch((error: unknown) => {
        console.error(`Stopped following Toy Box channel ${link.channelId}:`, error);
        onError(error);
      })
      .finally(() => {
        if (followers.get(link.channelId) === follower) followers.delete(link.channelId);
      });
  }

  async function unfollow(follower: Follower) {
    follower.abort.abort();
    await follower.done;
  }

  // Only the stream's own failures retry. An error recording a frame ends the follower.
  async function run(follower: Follower) {
    const { link, abort } = follower;
    const { signal } = abort;
    follower.stream = await database.read((sql) => readToyBoxStream(sql, link.channelId));
    let failures = 0;
    let failing = false;
    while (!signal.aborted) {
      const events = readServerSentEvents(
        readChannelStream(origin, link.channelId, follower.stream.revision, {
          signal,
          idleTimeout,
        }),
      );
      let established = false;
      let failure = "Toy Box closed the stream.";
      try {
        for (;;) {
          const next = await events.next().catch((error: unknown) => ({ error }));
          if ("error" in next) {
            failure = describe(next.error);
            break;
          }
          if (next.done) break;
          const received = await receive(follower, next.value);
          if (received === "deleted") return;
          if (received !== "established") continue;
          established = true;
          failures = 0;
          if (failing) console.error(`Following Toy Box channel ${link.channelId} again.`);
          failing = false;
        }
      } finally {
        await events.return(undefined);
      }
      if (signal.aborted) return;
      if (!failing) console.error(`Can't follow Toy Box channel ${link.channelId}: ${failure}`);
      failing = true;
      setConnected(follower, false);
      await sleep(established ? reconnectDelay : retryDelay(++failures, timings), signal);
    }
  }

  async function receive(follower: Follower, event: ServerSentEvent): Promise<Received> {
    const { link } = follower;
    const frame = parseChannelFrame(event.data);
    if (!frame) {
      // The frame still moved the revision, and a reconnect resumes after it.
      console.error(`Skipped a frame on Toy Box channel ${link.channelId} the bridge can't read.`);
      const revision = Number(event.id);
      if (event.id && Number.isSafeInteger(revision) && revision >= 0) {
        await record(follower, { revision });
      }
      return undefined;
    }
    const observation = observeChannelFrame(frame, link.channelId);
    if (observation.members) forgetCatalog();
    const changed = await record(follower, observation);
    if (frame.type === "deleted") {
      deleted.add(link.channelId);
      follower.connected = false;
      onChange([link.id]);
      return "deleted";
    }
    const established = frame.type === "snapshot" || frame.type === "resumed";
    if (established && !follower.connected) setConnected(follower, true);
    else if (changed) onChange([link.id]);
    return established ? "established" : undefined;
  }

  // Applies one frame and says whether it changed what a wake decision reads. The owner speaking
  // releases the holds taken before, and a deleted channel ends its link's requests.
  async function record(follower: Follower, observation: ChannelObservation): Promise<boolean> {
    const { link } = follower;
    const previous = follower.stream;
    const stream = reduceToyBoxStream(previous, observation);
    const touchesLink = observation.routines !== undefined || observation.deleted === true;
    if (!touchesLink && Bun.deepEquals(stream, previous)) return false;
    const linkChanged = await database.write(async (transaction) => {
      await writeToyBoxStream(transaction, link.channelId, stream);
      const at = now();
      const changes = [await recordLinkRoutines(transaction, link.id, observation, at)];
      if (stream.ownerSpokeAt !== null && stream.ownerSpokeAt !== previous.ownerSpokeAt) {
        changes.push(await releaseHolds(transaction, link.id, stream.ownerSpokeAt));
      }
      if (observation.deleted === true) {
        changes.push(await suspendLink(transaction, link.id, "toybox_channel_deleted", at));
        changes.push(await cancelLinkRequests(transaction, link.id, "toybox_channel_deleted", at));
      }
      return changes.includes(true);
    });
    follower.stream = stream;
    return (
      linkChanged ||
      stream.provider !== previous.provider ||
      isWorking(stream) !== isWorking(previous)
    );
  }

  function forgetCatalog() {
    catalog = null;
    memberChanges += 1;
  }

  function setConnected(follower: Follower, connected: boolean) {
    if (follower.connected === connected) return;
    follower.connected = connected;
    onChange([follower.link.id]);
  }

  return {
    view(channelId) {
      const follower = followers.get(channelId);
      return {
        connected: follower?.connected ?? false,
        provider: follower?.stream.provider ?? null,
        leadWorking: follower ? isWorking(follower.stream) : false,
      };
    },
    catalog() {
      return catalog;
    },
    loadCatalog() {
      if (catalogRead?.memberChanges === memberChanges) return catalogRead.read;
      const changes = memberChanges;
      const read = fetchToyBoxCatalog(origin)
        .then((loaded) => {
          if (changes === memberChanges) catalog = loaded;
          return loaded;
        })
        .finally(() => {
          if (catalogRead?.read === read) catalogRead = undefined;
        });
      catalogRead = { memberChanges: changes, read };
      return read;
    },
    runRoutine(channelId, routineId) {
      return runToyBoxRoutine(origin, channelId, routineId);
    },
    followLinks() {
      return reconciling.enqueue(async () => {
        if (stopped) return;
        const links = await database.read(readFollowedLinks);
        const linked = new Map(links.map((link) => [link.channelId, link.id]));
        for (const follower of [...followers.values()]) {
          if (linked.get(follower.link.channelId) !== follower.link.id) await unfollow(follower);
        }
        for (const link of links) {
          if (!followers.has(link.channelId) && !deleted.has(link.channelId)) follow(link);
        }
      });
    },
    stop() {
      stopped = true;
      return reconciling.enqueue(async () => {
        await Promise.all([...followers.values()].map(unfollow));
      });
    },
  };
}

function isWorking(stream: ToyBoxStream): boolean {
  return stream.lead?.state === "working";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
