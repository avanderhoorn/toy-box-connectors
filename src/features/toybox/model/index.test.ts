import { describe, expect, test } from "bun:test";
import {
  channelFrameSchema,
  publishCommand,
  REQUESTS_COMMAND,
  routineRunOutcome,
  routineState,
  toyBoxCatalogSchema,
} from ".";

// Shapes follow the toy-box repo: listChannelsResponse in src/features/channels/server/api.ts and
// ChannelState and ChannelObservationEvent in src/features/channels/model/index.ts.
const channel = {
  id: "lead-1",
  name: "Toy Box Slack",
  purpose: "Answer Slack",
  model: { provider: "copilot", id: "claude-opus-5.5", reasoningEffort: "high" },
  tasks: [],
  latestSequence: 3,
  seenThrough: 3,
  completedSequence: null,
  requestSequence: null,
  updatedAt: "2026-10-27T16:00:00.000Z",
};

describe("the channel catalog", () => {
  test("keeps each channel's provider, the members and who is working, and drops the rest", () => {
    const catalog = toyBoxCatalogSchema.parse({
      version: 1,
      channels: [channel],
      members: [{ id: "member-1", channelId: "lead-1", name: "Bridge Engineer", avatar: {} }],
      lead: { name: "Lead", role: "Coordinates the channel" },
      working: ["member-1"],
    });

    expect(catalog).toEqual({
      version: 1,
      channels: [{ id: "lead-1", name: "Toy Box Slack", model: { provider: "copilot" } }],
      members: [{ id: "member-1", channelId: "lead-1", name: "Bridge Engineer" }],
      working: ["member-1"],
    });
  });

  test("a catalog of another version isn't read", () => {
    const catalog = { version: 2, channels: [], members: [], working: [] };
    expect(toyBoxCatalogSchema.safeParse(catalog).success).toBe(false);
  });
});

describe("channel frames", () => {
  test("a snapshot keeps what the bridge acts on", () => {
    const routine = { id: "routine-1", title: "Slack", schedule: "0 9 * * 1-5", prompt: "Run it" };
    const frame = channelFrameSchema.parse({
      type: "snapshot",
      state: {
        revision: 12,
        channel,
        lead: { id: "lead-1", name: "Lead", role: "Lead", avatar: {} },
        members: [],
        messages: [
          {
            id: "m-1",
            sequence: 1,
            timestamp: "2026-10-27T16:00:00.000Z",
            sender: { type: "user" },
            content: "Hi",
            reactions: [],
          },
          {
            id: "m-2",
            sequence: 2,
            timestamp: "2026-10-27T16:01:00.000Z",
            sender: { type: "system" },
            content: { type: "routine_scheduled", routine },
          },
        ],
        request: null,
        artifacts: [],
        routines: [routine],
        presence: {
          "lead-1": { state: "waiting", text: "The owner", wakeAt: "2026-10-27T17:00Z" },
        },
      },
    });

    expect(frame).toEqual({
      type: "snapshot",
      state: {
        revision: 12,
        channel: { model: { provider: "copilot" } },
        messages: [
          { timestamp: "2026-10-27T16:00:00.000Z", sender: { type: "user" }, content: "Hi" },
          {
            timestamp: "2026-10-27T16:01:00.000Z",
            sender: { type: "system" },
            content: { type: "routine_scheduled", routine },
          },
        ],
        routines: [routine],
        presence: {
          "lead-1": { state: "waiting", text: "The owner", wakeAt: "2026-10-27T17:00Z" },
        },
      },
    });
  });

  test("one agent's unfamiliar presence doesn't drop the frame", () => {
    const frame = channelFrameSchema.parse({
      type: "presence",
      presence: { "lead-1": { state: "working" }, "member-1": { state: "dreaming" } },
    });
    expect(frame).toEqual({
      type: "presence",
      presence: { "lead-1": { state: "working" }, "member-1": { state: "dreaming" } },
    });
  });

  test.each(["reaction", "tasks", "read", "member", "status"] as const)(
    "a %s detail the bridge doesn't act on still carries its revision",
    (type) => {
      expect(channelFrameSchema.parse({ type, revision: 7, agentId: "lead-1" })).toEqual({
        type,
        revision: 7,
      });
    },
  );

  test("a model change carries the channel's new provider", () => {
    const frame = channelFrameSchema.parse({
      type: "model",
      revision: 8,
      model: { provider: "claude", id: "opus" },
      updatedAt: "2026-10-27T16:00:00.000Z",
    });
    expect(frame).toEqual({ type: "model", revision: 8, model: { provider: "claude" } });
  });

  test("a deleted channel names itself", () => {
    expect(channelFrameSchema.parse({ type: "deleted", channelId: "lead-1" })).toEqual({
      type: "deleted",
      channelId: "lead-1",
    });
  });

  test.each([
    ["an unknown type", { type: "artifacts", revision: 3 }],
    ["a detail without its revision", { type: "read", seenThrough: 3 }],
    ["a negative revision", { type: "read", revision: -1 }],
    ["a fractional revision", { type: "read", revision: 1.5 }],
  ])("%s isn't a frame the bridge reads", (_name, frame) => {
    expect(channelFrameSchema.safeParse(frame).success).toBe(false);
  });
});

describe("routine state", () => {
  const routine = (prompt: string) => ({ prompt });

  test("a routine Toy Box no longer has is missing", () => {
    expect(routineState(null, REQUESTS_COMMAND)).toBe("missing");
  });

  test("a routine whose prompt still runs its command is present, however the lead wraps it", () => {
    expect(routineState(routine("Run `toy-box-slack inbox` and answer."), REQUESTS_COMMAND)).toBe(
      "present",
    );
    expect(routineState(routine("Run toy-box-slack\n  inbox."), REQUESTS_COMMAND)).toBe("present");
    expect(
      routineState(
        routine("Otherwise pipe the notes to `toy-box-slack publish --series release-notes`."),
        publishCommand("release-notes"),
      ),
    ).toBe("present");
  });

  test("a routine whose prompt lost its command has drifted", () => {
    expect(routineState(routine("Check Slack."), REQUESTS_COMMAND)).toBe("drifted");
    expect(routineState(routine("Run toy-box-slack inboxes."), REQUESTS_COMMAND)).toBe("drifted");
    expect(
      routineState(
        routine("Run `toy-box-slack publish --series release-notes`."),
        publishCommand("release"),
      ),
    ).toBe("drifted");
  });
});

describe("routine run outcomes", () => {
  test.each([
    [204, "ran"],
    [200, "ran"],
    [404, "missing"],
    [500, "failed"],
    [503, "failed"],
    [400, "refused"],
    [422, "refused"],
    [302, "refused"],
    [401, "refused"],
  ] as const)("%i means %s", (status, outcome) => {
    expect(routineRunOutcome(status)).toBe(outcome);
  });
});
