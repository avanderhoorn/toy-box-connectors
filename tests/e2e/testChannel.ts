// A Toy Box channel an end-to-end test drives.
//
// Each test channel's purpose asks its lead for a kickoff message and rules out members, tasks and
// wakes it schedules itself, so only the test starts the lead's turns. The harness follows the
// channel's stream from creation, so a test reads the lead's presence, messages and routines as Toy
// Box reports them. A test wakes the lead only once it has settled, so no wake steers into a turn
// that's still running.

import { z } from "zod";
import { LEAD_MODEL, waitUntil, type IsolatedToyBox } from "./isolatedToyBox";
import {
  callToyBox,
  readChannelFrames,
  routineChangeSchema,
  type Frame,
  type Message,
  type Presence,
  type Routine,
} from "./toyBoxApi";

const TEST_CHANNEL_RULES =
  "This channel runs an end-to-end test. Start with one short kickoff message, then do only what the owner or a routine asks. Never add members or create tasks, and pass wakeAfterMinutes only when asked to.";

const TURN_START_TIMEOUT = 90_000;
const TURN_FINISH_TIMEOUT = 240_000;

/** How long creating a channel can take, its lead's kickoff turn included. */
export const CREATE_CHANNEL_TIMEOUT = TURN_START_TIMEOUT + TURN_FINISH_TIMEOUT + 30_000;

/** How long one `turn` can take, from waiting out the turn before it. */
export const TURN_TIMEOUT = 2 * TURN_FINISH_TIMEOUT + TURN_START_TIMEOUT;

export type TestChannel = {
  id: string;
  /** The routine the lead registered as `title`, once Toy Box reports it. */
  routine(title: string): Routine | undefined;
  /** Waits for the lead to settle, wakes it with `wake`, and resolves once that turn settles. */
  turn(wake: () => Promise<void>): Promise<void>;
};

const createdChannelSchema = z.object({
  channel: z.object({
    id: z.string(),
    model: z.object({ provider: z.string(), name: z.string() }),
  }),
});

/** Creates a channel whose lead runs the test model, and resolves once its kickoff has settled. */
export async function createTestChannel(
  toyBox: IsolatedToyBox,
  options: { name: string; purpose: string },
): Promise<TestChannel> {
  try {
    const testChannel = followChannel(toyBox, await createChannel(toyBox, options));
    await testChannel.kickedOff();
    return testChannel;
  } catch (error) {
    throw toyBox.failure(error);
  }
}

async function createChannel(
  toyBox: IsolatedToyBox,
  { name, purpose }: { name: string; purpose: string },
): Promise<string> {
  const response = await callToyBox(toyBox.origin, "channels", {
    method: "POST",
    body: {
      name,
      purpose: `${purpose}\n\n${TEST_CHANNEL_RULES}`,
      directory: toyBox.work,
      model: LEAD_MODEL,
    },
    expected: 201,
  });
  const { channel } = createdChannelSchema.parse(await response.json());
  // Toy Box gives a channel its first model when it doesn't offer the one asked for.
  if (channel.model.provider !== LEAD_MODEL.provider || channel.model.name !== LEAD_MODEL.name) {
    throw new Error(`Toy Box gave the channel ${channel.model.provider}'s ${channel.model.name}.`);
  }
  return channel.id;
}

function followChannel(toyBox: IsolatedToyBox, channelId: string) {
  const presences: Presence[] = [];
  let leadPosted = false;
  const routines = new Map<string, Routine>();
  let failure: unknown;

  void (async () => {
    try {
      for await (const frame of readChannelFrames(toyBox.origin, channelId, toyBox.signal)) {
        observe(frame);
      }
      failure ??= new Error(`Toy Box ended channel ${channelId}'s stream.`);
    } catch (error) {
      failure ??= error;
    }
  })();

  function observe(frame: Frame) {
    switch (frame.type) {
      case "snapshot":
        observePresence(frame.state.presence);
        for (const routine of frame.state.routines) routines.set(routine.id, routine);
        for (const message of frame.state.messages) observeMessage(message);
        return;
      case "resumed":
      case "presence":
        return observePresence(frame.presence);
      case "message":
        return observeMessage(frame.message);
      case "deleted":
        failure ??= new Error(`Toy Box deleted channel ${channelId}.`);
        return;
    }
  }

  // A presence frame names only the agents whose presence changed.
  function observePresence(presence: Record<string, Presence>) {
    if (Object.hasOwn(presence, channelId)) presences.push(presence[channelId]);
  }

  // The channel has no members, so every agent message is its lead's.
  function observeMessage(message: Message) {
    if (message.sender.type === "agent") leadPosted = true;
    const change = routineChangeSchema.safeParse(message.content);
    if (message.sender.type !== "system" || !change.success) return;
    const { type, routine } = change.data;
    if (type === "routine_deleted") routines.delete(routine.id);
    else routines.set(routine.id, routine);
  }

  /** Throws what ended the stream, so a wait fails at once rather than at its deadline. */
  function following() {
    if (failure !== undefined) throw failure;
  }

  function settled(): true | undefined {
    following();
    const presence = presences.at(-1);
    return presence && presence.state !== "working" ? true : undefined;
  }

  return {
    id: channelId,
    routine: (title: string) => [...routines.values()].find((routine) => routine.title === title),

    async turn(wake: () => Promise<void>) {
      await waitUntil("the lead to finish its last turn", settled, TURN_FINISH_TIMEOUT);
      const before = presences.length;
      await wake();
      await waitUntil(
        "the lead to start working",
        () => {
          following();
          return presences.slice(before).some(isWorking) || undefined;
        },
        TURN_START_TIMEOUT,
      );
      await waitUntil("the lead to finish its turn", settled, TURN_FINISH_TIMEOUT);
    },

    /**
     * Resolves once the lead has posted and stopped working. A lead that never starts, or stops
     * without posting, fails at once, which is how a model or token Copilot refuses shows up. So
     * does one that schedules its own wake, which could start a turn in the middle of a scenario.
     */
    async kickedOff() {
      const created = Date.now();
      let quietSince: number | undefined;
      await waitUntil(
        "the lead's kickoff turn to post and settle",
        () => {
          if (settled() && leadPosted) {
            const presence = presences.at(-1);
            if (presence?.state === "waiting" && presence.wakeAt) {
              throw new Error(`The lead scheduled a wake for ${presence.wakeAt} at kickoff.`);
            }
            return true;
          }
          if (!presences.some(isWorking)) {
            if (Date.now() - created < TURN_START_TIMEOUT) return undefined;
            throw new Error(
              `The lead didn't start its kickoff turn in ${TURN_START_TIMEOUT / 1000} s.`,
            );
          }
          // Its message can trail the presence that ends its turn.
          quietSince = settled() ? (quietSince ?? Date.now()) : undefined;
          if (quietSince !== undefined && Date.now() - quietSince > 2_000) {
            throw new Error("The lead finished its kickoff turn without posting.");
          }
          return undefined;
        },
        TURN_START_TIMEOUT + TURN_FINISH_TIMEOUT,
      );
    },
  };
}

function isWorking(presence: Presence): boolean {
  return presence.state === "working";
}
