import { describe, expect, test } from "bun:test";
import type { ToyBoxCatalog } from "@toybox/model";
import {
  permitCaller,
  readCallerFacts,
  resolveCaller,
  type Caller,
  type CallerFacts,
  type CallerResolution,
} from "./callers";

const origin = new URL("http://127.0.0.1:3000");

const catalog: ToyBoxCatalog = {
  version: 1,
  channels: [
    { id: "release-eng", name: "Release engineering", model: { provider: "copilot" } },
    { id: "design", name: "Design", model: { provider: "copilot" } },
  ],
  members: [{ id: "agent-reviewer", channelId: "release-eng", name: "Reviewer" }],
  working: [],
};

const toyBox = { origin, catalog };

function facts(overrides: Partial<CallerFacts>): CallerFacts {
  return { sessionId: null, toyBoxPort: null, channelId: null, ...overrides };
}

describe("reading what the environment says about the caller", () => {
  test("forwards the session, Toy Box's port and the channel --channel named", () => {
    const env = { COPILOT_AGENT_SESSION_ID: "release-eng", NITRO_PORT: "3000" };

    expect(readCallerFacts(env, "design")).toEqual({
      sessionId: "release-eng",
      toyBoxPort: 3000,
      channelId: "design",
    });
    expect(readCallerFacts({}, null)).toEqual(facts({}));
  });

  test("trims both, and a blank variable says nothing", () => {
    expect(
      readCallerFacts({ COPILOT_AGENT_SESSION_ID: " release-eng\n", NITRO_PORT: " 3000 " }, null),
    ).toEqual(facts({ sessionId: "release-eng", toyBoxPort: 3000 }));
    expect(readCallerFacts({ COPILOT_AGENT_SESSION_ID: "  ", NITRO_PORT: "" }, null)).toEqual(
      facts({}),
    );
  });

  test.each(["1", "65535"])("takes %p as a port", (port) => {
    expect(readCallerFacts({ NITRO_PORT: port }, null).toyBoxPort).toBe(Number(port));
  });

  test.each(["0", "65536", "123456", "-1", "+80", "3.5", "1e3", "0x10", "3000abc", "abc"])(
    "doesn't take %p as a port",
    (port) => {
      expect(readCallerFacts({ NITRO_PORT: port }, null).toyBoxPort).toBeNull();
    },
  );
});

describe("resolving who is calling", () => {
  test("a session that is a channel's ID is that channel's lead", () => {
    expect(resolveCaller(facts({ sessionId: "release-eng", toyBoxPort: 3000 }), toyBox)).toEqual({
      kind: "caller",
      caller: { role: "lead", channelId: "release-eng", sessionId: "release-eng" },
    });
    expect(
      resolveCaller(facts({ sessionId: "release-eng", channelId: "release-eng" }), toyBox),
    ).toEqual({
      kind: "caller",
      caller: { role: "lead", channelId: "release-eng", sessionId: "release-eng" },
    });
  });

  test("a member's session is a member of the member's channel", () => {
    expect(resolveCaller(facts({ sessionId: "agent-reviewer" }), toyBox)).toEqual({
      kind: "caller",
      caller: { role: "member", channelId: "release-eng", sessionId: "agent-reviewer" },
    });
  });

  test("a caller without a session is the operator, for the channel it names if any", () => {
    expect(resolveCaller(facts({ channelId: "design" }), toyBox)).toEqual({
      kind: "caller",
      caller: { role: "operator", channelId: "design", sessionId: null },
    });
    expect(resolveCaller(facts({ channelId: "design" }), { origin, catalog: null })).toEqual({
      kind: "caller",
      caller: { role: "operator", channelId: "design", sessionId: null },
    });
    expect(resolveCaller(facts({}), toyBox)).toEqual({
      kind: "caller",
      caller: { role: "operator", channelId: null, sessionId: null },
    });
  });

  test("a session the catalog doesn't list is refused", () => {
    expect(resolveCaller(facts({ sessionId: "stranger" }), toyBox)).toEqual({
      kind: "refused",
      rule: "unknown_session",
      message:
        "Session stranger isn't the lead or a member of a channel in the Toy Box at http://127.0.0.1:3000, so the bridge won't act for it.",
    });
    expect(resolveCaller(facts({ sessionId: "release-eng" }), { origin, catalog: null })).toEqual(
      expect.objectContaining({ kind: "refused", rule: "unknown_session" }),
    );
  });

  test("a --channel that disagrees with the session is refused", () => {
    expect(resolveCaller(facts({ sessionId: "release-eng", channelId: "design" }), toyBox)).toEqual(
      {
        kind: "refused",
        rule: "channel_mismatch",
        message:
          "You lead channel release-eng, but --channel names design. Leave out --channel to act for your own channel.",
      },
    );
    expect(
      resolveCaller(facts({ sessionId: "agent-reviewer", channelId: "design" }), toyBox),
    ).toEqual({
      kind: "refused",
      rule: "channel_mismatch",
      message:
        "You're a member of channel release-eng, but --channel names design. Leave out --channel to act for your own channel.",
    });
  });

  test("a caller in another Toy Box is refused before its session is looked up", () => {
    const refusal: CallerResolution = {
      kind: "refused",
      rule: "toy_box_port",
      message:
        "You're running in the Toy Box on port 3100, but this bridge serves the one at http://127.0.0.1:3000, so it won't act for you.",
    };
    expect(resolveCaller(facts({ sessionId: "release-eng", toyBoxPort: 3100 }), toyBox)).toEqual(
      refusal,
    );
    expect(resolveCaller(facts({ channelId: "design", toyBoxPort: 3100 }), toyBox)).toEqual(
      refusal,
    );
  });

  test("a Toy Box URL without a port is on port 80", () => {
    const portless = { origin: new URL("http://localhost"), catalog };
    expect(resolveCaller(facts({ channelId: "design", toyBoxPort: 80 }), portless)).toEqual(
      expect.objectContaining({ kind: "caller" }),
    );
    expect(resolveCaller(facts({ channelId: "design", toyBoxPort: 3000 }), portless)).toEqual(
      expect.objectContaining({ kind: "refused", rule: "toy_box_port" }),
    );
  });
});

describe("permitting a command", () => {
  const lead: Caller = { role: "lead", channelId: "release-eng", sessionId: "release-eng" };
  const member: Caller = { role: "member", channelId: "release-eng", sessionId: "agent-reviewer" };
  const operator: Caller = { role: "operator", channelId: "release-eng", sessionId: null };
  const anyone = ["lead", "member", "operator"] as const;

  test("lets a role the command allows run it", () => {
    expect(permitCaller(member, { name: "thread", roles: anyone, scope: "channel" })).toEqual({
      kind: "caller",
      caller: member,
    });
    expect(
      permitCaller(operator, { name: "pause", roles: ["lead", "operator"], scope: "channel" }),
    ).toEqual({ kind: "caller", caller: operator });
  });

  test("refuses a member anything but reading", () => {
    expect(permitCaller(member, { name: "reply", roles: ["lead"], scope: "channel" })).toEqual({
      kind: "refused",
      rule: "role",
      message: "Only the channel's lead can run `reply`. A member may only read.",
    });
    expect(
      permitCaller(member, { name: "pause", roles: ["lead", "operator"], scope: "channel" }),
    ).toEqual({
      kind: "refused",
      rule: "role",
      message: "Only the channel's lead or the operator can run `pause`. A member may only read.",
    });
  });

  test("refuses the operator a reply or a publication", () => {
    expect(permitCaller(operator, { name: "reply", roles: ["lead"], scope: "channel" })).toEqual({
      kind: "refused",
      rule: "role",
      message:
        "Only the channel's lead can run `reply`. The operator may read and run setup, but never reply or publish.",
    });
  });

  test("refuses the lead what only the operator may run", () => {
    expect(permitCaller(lead, { name: "doctor", roles: ["operator"], scope: "bridge" })).toEqual({
      kind: "refused",
      rule: "role",
      message:
        "Only the operator can run `doctor`. Ask whoever runs the bridge to run it from a terminal outside Toy Box.",
    });
  });

  test("makes the operator name a channel for a command that acts for one", () => {
    const unnamed: Caller = { ...operator, channelId: null };
    expect(permitCaller(unnamed, { name: "thread", roles: anyone, scope: "channel" })).toEqual({
      kind: "refused",
      rule: "channel_required",
      message:
        "`thread` acts for one Toy Box channel. Pass --channel with its ID, because from a terminal the bridge can't tell which channel you mean.",
    });
    expect(permitCaller(unnamed, { name: "doctor", roles: ["operator"], scope: "bridge" })).toEqual(
      { kind: "caller", caller: unnamed },
    );
  });
});
