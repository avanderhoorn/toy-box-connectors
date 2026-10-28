import { parseChannelFrame, viewChannel, type ToyBoxChannelView } from "@toybox/model/stream";
import { readChannelStream } from "./api";
import { readServerSentEvents } from "./sse";

// One read of a channel.
//
// Setup checks a change against a Toy Box channel as it is now, whether or not a link follows it,
// so it opens the channel's stream from scratch, takes the snapshot Toy Box starts every such
// stream with, and closes it. Nothing is stored.

// Toy Box sends its snapshot as soon as a stream opens, so a stream this quiet has failed.
const FIRST_FRAME_TIMEOUT_MS = 15_000;

/**
 * The channel as Toy Box shows it now, or null when Toy Box deleted it. Throws when Toy Box can't
 * be reached, starts the stream with anything but a snapshot, or hasn't when `signal` aborts.
 */
export async function readToyBoxChannel(
  origin: URL,
  channelId: string,
  { signal }: { signal: AbortSignal },
): Promise<ToyBoxChannelView | null> {
  const events = readServerSentEvents(
    readChannelStream(origin, channelId, null, { signal, idleTimeout: FIRST_FRAME_TIMEOUT_MS }),
  );
  try {
    const first = await events.next();
    if (first.done) {
      throw new Error(`Toy Box closed channel ${channelId}'s stream before it sent anything.`);
    }
    const frame = parseChannelFrame(first.value.data);
    const view = frame && viewChannel(frame);
    if (view === undefined) {
      throw new Error(`Toy Box started channel ${channelId}'s stream without a snapshot.`);
    }
    return view;
  } finally {
    await events.return(undefined);
  }
}
