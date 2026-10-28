import { describe, expect, test } from "bun:test";
import type { ChannelFrame, ToyBoxMessage, ToyBoxRoutine } from ".";
import {
  observeChannelFrame,
  observedRoutine,
  observeSeriesRoutine,
  parseChannelFrame,
  reduceToyBoxStream,
  viewChannel,
  type SeriesRoutine,
  type ToyBoxStream,
} from "./stream";

const routine: ToyBoxRoutine = {
  id: "routine-1",
  title: "Slack requests",
  schedule: "0 9 * * 1-5",
  prompt: "Run `toy-box-slack inbox`.",
};

function message(type: string, timestamp: string, content: unknown = "Hi"): ToyBoxMessage {
  return { timestamp, sender: { type }, content };
}

function snapshot(state: Partial<Extract<ChannelFrame, { type: "snapshot" }>["state"]>) {
  return {
    type: "snapshot",
    state: {
      revision: 12,
      channel: { model: { provider: "copilot" } },
      messages: [],
      routines: [],
      presence: {},
      ...state,
    },
  } satisfies ChannelFrame;
}

describe("reading a frame", () => {
  test("data that holds a frame reads as it, without what the bridge doesn't read", () => {
    const frame = snapshot({ routines: [routine] });
    const sent = { ...frame, state: { ...frame.state, artifacts: [] }, extra: true };
    expect(parseChannelFrame(JSON.stringify(sent))).toEqual(frame);
  });

  test("data that isn't JSON, or isn't a frame the bridge reads, reads as nothing", () => {
    expect(parseChannelFrame("{")).toBeUndefined();
    expect(parseChannelFrame(JSON.stringify({ type: "message", revision: -1 }))).toBeUndefined();
    expect(parseChannelFrame(JSON.stringify({ type: "unknown", revision: 3 }))).toBeUndefined();
  });
});

describe("observing a frame", () => {
  test("a snapshot sets the revision, provider, lead, routines and when the owner last spoke", () => {
    const frame = snapshot({
      messages: [
        message("user", "2026-10-27T16:05:00.000Z"),
        message("user", "2026-10-27T16:00:00.000Z"),
        message("agent", "2026-10-27T16:09:00.000Z"),
        message("system", "2026-10-27T16:10:00.000Z", { type: "tasks_completed" }),
        message("user", "not a time"),
      ],
      routines: [routine],
      presence: { "lead-1": { state: "working" }, "member-1": { state: "idle" } },
    });

    expect(observeChannelFrame(frame, "lead-1")).toEqual({
      revision: 12,
      provider: "copilot",
      lead: { presence: { state: "working" }, live: false },
      ownerSpokeAt: Date.parse("2026-10-27T16:05:00.000Z"),
      routines: { all: [routine] },
      members: true,
    });
  });

  test("a snapshot without the owner or the lead says nothing about them", () => {
    const observation = observeChannelFrame(
      snapshot({ messages: [message("agent", "2026-10-27T16:00:00.000Z")] }),
      "lead-1",
    );
    expect(observation.lead).toBeUndefined();
    expect(observation.ownerSpokeAt).toBeUndefined();
  });

  test("only presence events are live", () => {
    const presence = { "lead-1": { state: "working" } };
    expect(observeChannelFrame({ type: "presence", presence }, "lead-1")).toEqual({
      lead: { presence: { state: "working" }, live: true },
    });
    expect(observeChannelFrame({ type: "resumed", presence }, "lead-1")).toEqual({
      lead: { presence: { state: "working" }, live: false },
    });
  });

  test("presence that leaves out the lead or that the bridge can't read says nothing", () => {
    expect(
      observeChannelFrame({ type: "presence", presence: { "member-1": { state: "idle" } } }, "l"),
    ).toEqual({});
    expect(
      observeChannelFrame({ type: "presence", presence: { l: { state: "dreaming" } } }, "l"),
    ).toEqual({});
  });

  test("the owner's message moves when the owner last spoke and an agent's doesn't", () => {
    expect(
      observeChannelFrame(
        { type: "message", revision: 13, message: message("user", "2026-10-27T16:00:00.000Z") },
        "lead-1",
      ),
    ).toEqual({ revision: 13, ownerSpokeAt: Date.parse("2026-10-27T16:00:00.000Z") });
    expect(
      observeChannelFrame(
        { type: "message", revision: 14, message: message("agent", "2026-10-27T16:00:00.000Z") },
        "lead-1",
      ),
    ).toEqual({ revision: 14 });
  });

  test("a routine's system message changes the routines and other system messages don't", () => {
    const at = "2026-10-27T16:00:00.000Z";
    const change = { type: "routine_edited" as const, routine };
    expect(
      observeChannelFrame(
        { type: "message", revision: 15, message: message("system", at, change) },
        "lead-1",
      ),
    ).toEqual({ revision: 15, routines: change });
    expect(
      observeChannelFrame(
        {
          type: "message",
          revision: 16,
          message: message("system", at, { type: "channel_renamed", name: "x" }),
        },
        "lead-1",
      ),
    ).toEqual({ revision: 16 });
  });

  test("a model change sets the provider and a deletion says so", () => {
    expect(
      observeChannelFrame({ type: "model", revision: 17, model: { provider: "claude" } }, "l"),
    ).toEqual({ revision: 17, provider: "claude" });
    expect(observeChannelFrame({ type: "deleted", channelId: "l" }, "l")).toEqual({
      members: true,
      deleted: true,
    });
  });

  test("a member joining or leaving says the members changed", () => {
    const at = "2026-10-27T16:00:00.000Z";
    const member = { id: "member-1", name: "Reviewer" };
    for (const type of ["member_joined", "member_left"]) {
      expect(
        observeChannelFrame(
          { type: "message", revision: 19, message: message("system", at, { type, member }) },
          "lead-1",
        ),
      ).toEqual({ revision: 19, members: true });
    }
  });

  test("any other detail only moves the revision", () => {
    expect(observeChannelFrame({ type: "tasks", revision: 18 }, "lead-1")).toEqual({
      revision: 18,
    });
  });
});

describe("viewing a channel", () => {
  test("a snapshot shows the provider, the routines and when the owner last spoke", () => {
    const frame = snapshot({
      channel: { model: { provider: "claude" } },
      messages: [
        message("user", "2026-10-27T16:05:00.000Z"),
        message("agent", "2026-10-27T16:09:00.000Z"),
        message("user", "2026-10-27T16:00:00.000Z"),
      ],
      routines: [routine],
    });

    expect(viewChannel(frame)).toEqual({
      provider: "claude",
      ownerSpokeAt: Date.parse("2026-10-27T16:05:00.000Z"),
      routines: [routine],
    });
  });

  test("a snapshot without the owner's messages shows they haven't spoken in it", () => {
    const frame = snapshot({ messages: [message("agent", "2026-10-27T16:00:00.000Z")] });
    expect(viewChannel(frame)?.ownerSpokeAt).toBeNull();
  });

  test("a deletion shows the channel is gone and any other frame shows nothing", () => {
    expect(viewChannel({ type: "deleted", channelId: "lead-1" })).toBeNull();
    expect(viewChannel({ type: "resumed", presence: {} })).toBeUndefined();
    const owner = message("user", "2026-10-27T16:00:00.000Z");
    expect(viewChannel({ type: "message", revision: 13, message: owner })).toBeUndefined();
  });
});

describe("reducing the stream", () => {
  const stream: ToyBoxStream = {
    revision: 10,
    ownerSpokeAt: 1_000,
    provider: "copilot",
    lead: { state: "waiting", waiting: { text: "CI", wakeAt: null } },
  };

  test("an observation that says nothing keeps the stream", () => {
    expect(reduceToyBoxStream(stream, {})).toEqual(stream);
  });

  test("applies the revision, provider and the lead's presence", () => {
    expect(
      reduceToyBoxStream(stream, {
        revision: 11,
        provider: "claude",
        lead: { presence: { state: "working" }, live: true },
      }),
    ).toEqual({
      revision: 11,
      ownerSpokeAt: 1_000,
      provider: "claude",
      lead: { state: "working", restore: { text: "CI", wakeAt: null } },
    });
  });

  test("when the owner last spoke only moves forward", () => {
    expect(reduceToyBoxStream(stream, { ownerSpokeAt: 2_000 }).ownerSpokeAt).toBe(2_000);
    expect(reduceToyBoxStream(stream, { ownerSpokeAt: 500 }).ownerSpokeAt).toBe(1_000);
    expect(
      reduceToyBoxStream({ ...stream, ownerSpokeAt: null }, { ownerSpokeAt: 0 }).ownerSpokeAt,
    ).toBe(0);
  });
});

describe("observed routines", () => {
  test("a snapshot shows each routine it has and lacks every other", () => {
    const observation = { routines: { all: [routine] } };
    expect(observedRoutine(observation, "routine-1")).toEqual(routine);
    expect(observedRoutine(observation, "routine-2")).toBeNull();
  });

  test("a routine's change shows only that routine", () => {
    for (const type of ["routine_scheduled", "routine_edited"] as const) {
      expect(observedRoutine({ routines: { type, routine } }, "routine-1")).toEqual(routine);
    }
    expect(observedRoutine({ routines: { type: "routine_deleted", routine } }, "routine-1")).toBe(
      null,
    );
    expect(
      observedRoutine({ routines: { type: "routine_deleted", routine } }, "routine-2"),
    ).toBeUndefined();
  });

  test("an observation without routines says nothing about them", () => {
    expect(observedRoutine({ revision: 3 }, "routine-1")).toBeUndefined();
  });
});

describe("a series' routine", () => {
  const series: SeriesRoutine = {
    series: "release-notes",
    state: "present",
    schedule: "0 16 * * 5",
    registeredAt: 1_000,
  };
  const publish = {
    ...routine,
    schedule: "0 16 * * 5",
    prompt: "Pipe the notes to `toy-box-slack publish --series release-notes`.",
  };

  test("keeps its registration while its schedule stays", () => {
    expect(observeSeriesRoutine(series, publish, 9_000)).toEqual(series);
    expect(observeSeriesRoutine(series, { ...publish, prompt: "Post notes." }, 9_000)).toEqual({
      ...series,
      state: "drifted",
    });
  });

  test("a new schedule registers the series again", () => {
    expect(observeSeriesRoutine(series, { ...publish, schedule: "0 16 * * 1-5" }, 9_000)).toEqual({
      ...series,
      schedule: "0 16 * * 1-5",
      registeredAt: 9_000,
    });
  });

  test("a missing routine keeps the schedule it was registered with", () => {
    expect(observeSeriesRoutine(series, null, 9_000)).toEqual({ ...series, state: "missing" });
  });
});
