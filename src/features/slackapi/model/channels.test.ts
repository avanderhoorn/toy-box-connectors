import { expect, test } from "bun:test";
import { slackConversationSchema } from "./channels";

/** A private channel as conversations.info returns it, with fields the bridge doesn't keep. */
const privateChannel = {
  id: "C0PRIVATE",
  name: "toy-box-private",
  is_channel: true,
  is_group: false,
  is_im: false,
  is_mpim: false,
  is_private: true,
  created: 1700000000,
  is_archived: false,
  is_general: false,
  is_shared: false,
  is_org_shared: false,
  is_pending_ext_shared: false,
  is_ext_shared: false,
  is_member: true,
  context_team_id: "T0HOME",
  topic: { value: "deploys", creator: "U0OWNER", last_set: 1700000000 },
  num_members: 4,
};

test("a channel reads as the facts that decide its audience", () => {
  expect(slackConversationSchema.parse(privateChannel)).toEqual({
    id: "C0PRIVATE",
    name: "toy-box-private",
    kind: "private",
    isMember: true,
    isArchived: false,
    isExtShared: false,
    isPendingExtShared: false,
    isOrgShared: false,
  });
});

test("each flag reads as Slack set it", () => {
  const flags = {
    is_member: "isMember",
    is_archived: "isArchived",
    is_ext_shared: "isExtShared",
    is_pending_ext_shared: "isPendingExtShared",
    is_org_shared: "isOrgShared",
  };
  const cleared = Object.fromEntries(Object.keys(flags).map((flag) => [flag, false]));
  for (const [flag, fact] of Object.entries(flags)) {
    const facts = slackConversationSchema.parse({ ...privateChannel, ...cleared, [flag]: true });
    expect(facts).toMatchObject({
      isMember: fact === "isMember",
      isArchived: fact === "isArchived",
      isExtShared: fact === "isExtShared",
      isPendingExtShared: fact === "isPendingExtShared",
      isOrgShared: fact === "isOrgShared",
    });
  }
});

test("a conversation's kind comes from its type flags", () => {
  const kind = (flags: Record<string, unknown>) =>
    slackConversationSchema.parse({ ...privateChannel, ...flags }).kind;

  expect(kind({ is_private: false })).toBe("public");
  expect(kind({ is_im: true, is_private: false, name: undefined })).toBe("im");
  expect(kind({ is_mpim: true })).toBe("mpim");
});

test("a channel that doesn't say it's private reads as public, and as one the bot isn't in", () => {
  const vague = slackConversationSchema.parse({
    ...privateChannel,
    name: null,
    is_private: undefined,
    is_member: undefined,
  });
  expect(vague).toMatchObject({ name: null, kind: "public", isMember: false });
});

test("a conversation that leaves out an archive or sharing flag is refused", () => {
  for (const flag of ["is_archived", "is_ext_shared", "is_pending_ext_shared", "is_org_shared"]) {
    const conversation = { ...privateChannel, [flag]: undefined };
    expect(slackConversationSchema.safeParse(conversation).success).toBe(false);
  }
});
