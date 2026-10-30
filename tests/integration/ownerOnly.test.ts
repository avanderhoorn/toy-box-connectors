// Only the owner widens access, so `allow`, `resume` and `link` run only at a terminal, and each
// answers with what it changed, in names from Slack. Any process can pass for a terminal, so this
// stops a lead's mistake, not a process set on widening access. `deny`, `pause` and `unlink` only
// narrow, so they apply for the lead or a terminal.

import { expect, test } from "bun:test";
import { callBridge, type CallOptions } from "@commands/client/cli";
import type { LinkStatus } from "@commands/model/status";
import { countRows } from "@links/server/testFixtures";
import { withDatabase } from "./bridgeProcess";
import { ALICE, BOT, MALLORY, connectedBridge, said, timestamps } from "./connectedBridge";

/** Mallory as users.info describes her: a full member, whom the Enterprise org names W0MALLORY. */
const MALLORY_USER = {
  id: MALLORY,
  team_id: "T-home",
  enterprise_user: { id: "W0MALLORY", enterprise_id: "E-home" },
  real_name: "Mallory",
  is_bot: false,
  is_restricted: false,
  is_ultra_restricted: false,
};

type Caller = "the lead" | "a terminal";

/**
 * A connected bridge whose link watches C0LINK, a private channel the bot, Alice and Mallory are in,
 * and allows Alice, who has asked the lead something. `as` calls a command as `caller`, and `link`
 * reads the link as the owner at a terminal sees it.
 */
async function ownedBridge() {
  const bridge = await connectedBridge({ link: { slack_channel_id: "C0LINK" } });
  const { slack, channelId, home, post } = bridge;
  slack.setUser(MALLORY_USER);
  const [askedTs] = timestamps(1);
  const asked = said(ALICE, askedTs!, `<@${BOT}> can you check the deploy?`);
  await post(asked);

  const callers: Record<Caller, CallOptions> = {
    "the lead": { env: { COPILOT_AGENT_SESSION_ID: channelId } },
    "a terminal": { channelId, env: {} },
  };
  const as = (caller: Caller, name: string, input: Record<string, unknown> = {}) =>
    callBridge(name, input, { ...callers[caller], home });
  const link = async () =>
    ((await as("a terminal", "status")).json as { links: LinkStatus[] }).links[0];
  return { ...bridge, as, link };
}

/** Each widening command, with input that would widen the link. */
const WIDENING = [
  { name: "allow", input: { users: [MALLORY] } },
  { name: "resume", input: {} },
  { name: "link", input: { slackChannel: "C0LINK", requests: "all" } },
];

test("the lead widens access only if it's a terminal, which says what it changed", async () => {
  const { as, link } = await ownedBridge();
  // Paused, so resume has something to widen.
  expect(await as("the lead", "pause")).toMatchObject({
    exitCode: 0,
    json: { status: "paused" },
  });

  for (const { name, input } of WIDENING) {
    expect(await as("the lead", name, input)).toMatchObject({
      exitCode: 1,
      text: expect.stringContaining("Only the owner at a terminal runs"),
    });
    expect(await link()).toMatchObject({
      status: "paused",
      requestMode: "mention",
      allowlist: [ALICE],
    });
  }
});

test.each([{ caller: "the lead" }, { caller: "a terminal" }] as const)(
  "$caller narrows access at once with deny, pause and unlink, unless it's a member's session",
  async ({ caller }) => {
    const { as, link, stop, dataFolder } = await ownedBridge();

    expect(await as(caller, "deny", { users: [ALICE] })).toMatchObject({
      exitCode: 0,
      json: { cancelled: 1 },
      text: "They can't ask the lead to act from #C0LINK now. Cancelled 1 request of theirs.",
    });
    expect((await as(caller, "pause")).exitCode).toBe(0);
    expect(await link()).toMatchObject({ status: "paused", allowlist: [], pending: 0 });
    expect((await as(caller, "unlink")).exitCode).toBe(0);

    await stop();
    await withDatabase(dataFolder, async (database) => {
      expect(await countRows(database)).toMatchObject({
        links: 0,
        allowlist: 0,
        requests: 0,
        messages: 0,
      });
    });
  },
);

test("link says the channel's audience as Slack describes it as it links", async () => {
  const { slack, as, link } = await ownedBridge();
  // Someone made the channel public since it was linked.
  slack.addChannel({
    id: "C0LINK",
    name: "release-eng",
    is_private: false,
    members: [BOT, ALICE, MALLORY],
  });

  expect(await as("a terminal", "link", { slackChannel: "C0LINK", requests: "all" })).toMatchObject(
    {
      exitCode: 0,
      text: expect.stringContaining("#release-eng is public, so anyone in the bot's workspace can"),
    },
  );
  expect(await link()).toMatchObject({ status: "active", requestMode: "all" });
});

test("link won't move a link to another Slack channel until the owner unlinks it", async () => {
  const { slack, as } = await ownedBridge();
  slack.addChannel({ id: "C0OTHER", name: "general" });
  expect(await as("a terminal", "link", { slackChannel: "C0OTHER" })).toMatchObject({
    exitCode: 1,
    text: "This Toy Box channel is linked to #C0LINK. Run `toy-box-slack unlink` before you link it to another channel.",
  });
});

test("allow refuses a guest, and deny takes either of someone's IDs", async () => {
  const { slack, as, link } = await ownedBridge();
  const allow = () => as("a terminal", "allow", { users: ["W0MALLORY"] });

  slack.setUser({ ...MALLORY_USER, is_restricted: true });
  expect(await allow()).toMatchObject({
    exitCode: 1,
    text: "Nobody was allowed, since only full members of the bot's workspace or its Enterprise org can be, and Mallory (W0MALLORY) isn't: they're a guest.",
  });
  expect(await link()).toMatchObject({ allowlist: [ALICE] });
  slack.setUser(MALLORY_USER);
  expect(await allow()).toMatchObject({
    exitCode: 0,
    text: "Mallory (U0MALLORY) can ask the lead to act from #release-eng now.",
  });
  expect(await link()).toMatchObject({ allowlist: [ALICE, "Mallory"] });

  // The link allows her member ID, and deny finds it from the Enterprise one she was allowed by.
  expect((await as("a terminal", "deny", { users: ["W0MALLORY"] })).exitCode).toBe(0);
  expect(await link()).toMatchObject({ allowlist: [ALICE] });
});
