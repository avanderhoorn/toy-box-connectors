// Only the owner widens access. `allow`, `resume` and `link` answer first with what they'd widen,
// and apply it only when a call brings the owner's passphrase and names the change they were shown.
// Any process can pass for a terminal, so the passphrase, not the caller's role, is what stops a
// lead. `deny`, `pause` and `unlink` only narrow, so they apply at once for the lead or a terminal.

import { expect, test } from "bun:test";
import { writeCredential } from "@bridge/server/environment";
import { callBridge, type CallOptions } from "@commands/client/cli";
import type { LinkStatus } from "@commands/model/status";
import { countRows } from "@links/server/testFixtures";
import { withDatabase } from "./bridgeProcess";
import { ALICE, BOT, MALLORY, connectedBridge, said, timestamps } from "./connectedBridge";

const PASSPHRASE = "correct horse battery staple";
// Hashed cheaply, so each check takes milliseconds.
const HASH = await Bun.password.hash(PASSPHRASE, {
  algorithm: "argon2id",
  memoryCost: 8,
  timeCost: 1,
});
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

type Caller = "the lead" | "a member's session" | "a terminal";

/**
 * A connected bridge whose link watches C0LINK, a private channel the bot, Alice and Mallory are in,
 * and allows Alice, who has asked the lead something. The owner's passphrase is set. `as` calls a
 * command as `caller`, and `link` reads the link as the owner at a terminal sees it.
 */
async function ownedBridge() {
  const bridge = await connectedBridge({ link: { slack_channel_id: "C0LINK" } });
  const { slack, channelId, home, dataFolder, deliver } = bridge;
  slack.addChannel({
    id: "C0LINK",
    name: "release-eng",
    is_private: true,
    members: [BOT, ALICE, MALLORY],
  });
  slack.setUser(MALLORY_USER);
  writeCredential(dataFolder, "OWNER_PASSPHRASE_HASH", HASH);
  const [askedTs] = timestamps(1);
  const asked = said(ALICE, askedTs!, `<@${BOT}> can you check the deploy?`);
  slack.setMessage("C0LINK", asked);
  await deliver({ ...asked, channel: "C0LINK", event_ts: askedTs, channel_type: "group" });

  const callers: Record<Caller, CallOptions> = {
    "the lead": { env: { COPILOT_AGENT_SESSION_ID: channelId } },
    "a member's session": { env: { COPILOT_AGENT_SESSION_ID: "member-session" } },
    "a terminal": { channelId, env: {} },
  };
  const as = (
    caller: Caller,
    name: string,
    input: Record<string, unknown> = {},
    owner?: CallOptions["owner"],
  ) => callBridge(name, input, { ...callers[caller], home, owner });
  const link = async () =>
    ((await as("a terminal", "status")).json as { links: LinkStatus[] }).links[0];
  return { ...bridge, as, link };
}

/** Each widening command, a phrase from what it shows the owner, and what it changes. */
const WIDENING = [
  {
    name: "allow",
    input: { users: [MALLORY] },
    shows: "- Mallory (U0MALLORY)",
    widened: { allowlist: [ALICE, "Mallory"] },
  },
  {
    name: "resume",
    input: {},
    shows: "#release-eng is private, so only its members can",
    widened: { status: "active" },
  },
  {
    name: "link",
    input: { slackChannel: "C0LINK", requests: "all" },
    shows: "an allowed person posting at the top level or mentioning the bot",
    widened: { requestMode: "all" },
  },
];

test.each(
  (
    [
      { caller: "the lead", refusal: "Only the owner at a terminal runs" },
      { caller: "a member's session", refusal: "This session isn't the lead of a Toy Box channel" },
      { caller: "a terminal", refusal: null },
    ] as const
  ).flatMap(({ caller, refusal }) => [
    { caller, given: "no", passphrase: null, refusal },
    {
      caller,
      given: "a wrong",
      passphrase: "Tr0ub4dor&3",
      refusal: refusal ?? "That isn't the owner's passphrase",
    },
    { caller, given: "the right", passphrase: PASSPHRASE, refusal },
  ]),
)(
  "$caller with $given passphrase widens access only if it's a terminal with the right one",
  async ({ caller, passphrase, refusal }) => {
    const { as, link } = await ownedBridge();
    // Paused, so resume has something to widen.
    expect(await as("the lead", "pause")).toMatchObject({
      exitCode: 0,
      json: { status: "paused" },
    });
    const widens = caller === "a terminal" && passphrase === PASSPHRASE;

    let expected = { status: "paused", requestMode: "mention", allowlist: [ALICE] };
    for (const { name, input, shows, widened } of WIDENING) {
      const { exitCode, text, confirm } = await as("a terminal", name, input);
      expect({ exitCode, confirm: typeof confirm }).toEqual({ exitCode: 0, confirm: "string" });
      expect(text).toContain(shows);
      const owner = passphrase === null ? undefined : { passphrase, confirms: confirm! };
      expect(await as(caller, name, input, owner)).toMatchObject(
        refusal ? { exitCode: 1, text: expect.stringContaining(refusal) } : { exitCode: 0 },
      );
      if (widens) expected = { ...expected, ...widened };
      expect(await link()).toMatchObject(expected);
    }
  },
);

test.each([
  { caller: "the lead", narrows: true },
  { caller: "a member's session", narrows: false },
  { caller: "a terminal", narrows: true },
] as const)(
  "$caller narrows access at once with deny, pause and unlink, unless it's a member's session",
  async ({ caller, narrows }) => {
    const { as, link, stop, dataFolder } = await ownedBridge();

    const denied = await as(caller, "deny", { users: [ALICE] });
    expect(denied).toMatchObject(
      narrows ? { exitCode: 0, json: { cancelled: 1 } } : { exitCode: 1 },
    );
    expect((await as(caller, "pause")).exitCode).toBe(narrows ? 0 : 1);
    expect(await link()).toMatchObject(
      narrows
        ? { status: "paused", allowlist: [], pending: 0 }
        : { status: "active", allowlist: [ALICE], pending: 1 },
    );
    expect((await as(caller, "unlink")).exitCode).toBe(narrows ? 0 : 1);

    await stop();
    await withDatabase(dataFolder, async (database) => {
      const kept = narrows ? 0 : 1;
      expect(await countRows(database)).toMatchObject({
        links: kept,
        allowlist: kept,
        requests: kept,
        messages: kept,
      });
    });
  },
);

test("a change that's no longer what the owner was shown is refused", async () => {
  const { slack, as, link } = await ownedBridge();
  const input = { slackChannel: "C0LINK", requests: "all" };
  const shown = await as("a terminal", "link", input);
  // Someone makes the channel public before the owner types the passphrase.
  slack.addChannel({
    id: "C0LINK",
    name: "release-eng",
    is_private: false,
    members: [BOT, ALICE, MALLORY],
  });

  const owner = { passphrase: PASSPHRASE, confirms: shown.confirm! };
  expect(await as("a terminal", "link", input, owner)).toMatchObject({
    exitCode: 1,
    text: "What this would change isn't what you were shown anymore, so nothing changed. Run it again to see what it would change now.",
  });
  expect(await link()).toMatchObject({ requestMode: "mention" });
  expect((await as("a terminal", "link", input)).text).toContain(
    "#release-eng is public, so anyone in the bot's workspace can",
  );
});

test("allow refuses a guest when shown or confirmed, and deny takes either of someone's IDs", async () => {
  const { slack, as, link } = await ownedBridge();
  const guest = { ...MALLORY_USER, is_restricted: true };
  const allow = (owner?: CallOptions["owner"]) =>
    as("a terminal", "allow", { users: ["W0MALLORY"] }, owner);
  const refused = {
    exitCode: 1,
    text: "Nobody was allowed, since only full members of the bot's workspace or its Enterprise org can be, and Mallory (W0MALLORY) isn't: they're a guest.",
  };

  slack.setUser(guest);
  expect(await allow()).toMatchObject(refused);
  slack.setUser(MALLORY_USER);
  const owner = { passphrase: PASSPHRASE, confirms: (await allow()).confirm! };
  // She's made a guest after the owner was shown her, so their passphrase doesn't admit her.
  slack.setUser(guest);
  expect(await allow(owner)).toMatchObject(refused);
  slack.setUser(MALLORY_USER);
  expect((await allow(owner)).exitCode).toBe(0);
  expect(await link()).toMatchObject({ allowlist: [ALICE, "Mallory"] });

  // The link allows her member ID, and deny finds it from the Enterprise one she was allowed by.
  expect((await as("a terminal", "deny", { users: ["W0MALLORY"] })).exitCode).toBe(0);
  expect(await link()).toMatchObject({ allowlist: [ALICE] });
});
