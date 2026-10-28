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
  readLatestMessages,
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
  /** Runs the lead's routine titled `title`, and resolves once the turn it starts settles. */
  run(title: string): Promise<void>;
  /** Counts the lead's messages in Toy Box's store, which holds a turn's posts once it settles. */
  leadPosts(): Promise<number>;
};

const createdChannelSchema = z.object({ channel: z.object({ id: z.string() }) });

/** Creates a channel whose lead runs the test model, and resolves once its kickoff has settled. */
export async function createTestChannel(
  toyBox: IsolatedToyBox,
  options: { name: string; purpose: string },
): Promise<TestChannel> {
  try {
    const response = await callToyBox(toyBox.origin, "channels", {
      method: "POST",
      body: {
        name: options.name,
        purpose: `${options.purpose}\n\n${TEST_CHANNEL_RULES}`,
        directory: toyBox.work,
        model: LEAD_MODEL,
      },
      expected: 201,
    });
    const { channel } = createdChannelSchema.parse(await response.json());
    const testChannel = followChannel(toyBox, channel.id);
    await testChannel.kickedOff();
    return testChannel;
  } catch (error) {
    throw toyBox.failure(error);
  }
}

function followChannel(toyBox: IsolatedToyBox, channelId: string) {
  const presences: Presence[] = [];
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

  // System messages announce routine changes.
  function observeMessage(message: Message) {
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

  function routine(title: string) {
    return [...routines.values()].find((candidate) => candidate.title === title);
  }

  /** Waits for a turn to start after the presence at `since`, and resolves once it settles. */
  async function settledTurn(since: number, what: string) {
    await waitUntil(
      `the lead to start ${what}`,
      () => {
        following();
        return presences.slice(since).some(({ state }) => state === "working") || undefined;
      },
      TURN_START_TIMEOUT,
    );
    await waitUntil(`the lead to finish ${what}`, settled, TURN_FINISH_TIMEOUT);
  }

  async function turn(wake: () => Promise<void>) {
    await waitUntil("the lead to finish its last turn", settled, TURN_FINISH_TIMEOUT);
    const before = presences.length;
    await wake();
    await settledTurn(before, "its turn");
  }

  // The stream can deliver a message after the presence that ends its turn, so this reads the
  // store. The channel has no members, so every agent message is its lead's.
  async function leadPosts() {
    const messages = await readLatestMessages(toyBox.origin, channelId);
    return messages.filter(({ sender }) => sender.type === "agent").length;
  }

  return {
    id: channelId,
    routine,
    turn,
    leadPosts,

    async run(title: string) {
      const scheduled = routine(title);
      if (!scheduled) throw new Error(`The lead has no routine titled "${title}".`);
      const path = `channels/${channelId}/routines/${scheduled.id}/run`;
      await turn(async () => {
        await callToyBox(toyBox.origin, path, { method: "POST", expected: 204 });
      });
    },

    /**
     * Resolves once the lead's kickoff turn has posted and settled. A lead that stops without
     * posting fails, which is how a model or token Copilot refuses shows up. So does one that
     * schedules its own wake, which could start a turn in the middle of a scenario.
     */
    async kickedOff() {
      await settledTurn(0, "its kickoff turn");
      if (!(await leadPosts())) {
        throw new Error("The lead finished its kickoff turn without posting.");
      }
      const presence = presences.at(-1);
      if (presence?.state === "waiting" && presence.wakeAt) {
        throw new Error(`The lead scheduled a wake for ${presence.wakeAt} at kickoff.`);
      }
    },
  };
}
