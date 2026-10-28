import { expect, test } from "bun:test";
import { channelMembersPageSchema, slackConversationSchema } from "./channels";

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
  shared_team_ids: ["T0HOME"],
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
    enterpriseId: null,
    contextTeamId: "T0HOME",
    sharedTeamIds: ["T0HOME"],
  });
});

test("a channel in an Enterprise org names the org and each of its workspaces once, sorted", () => {
  const facts = slackConversationSchema.parse({
    ...privateChannel,
    is_org_shared: true,
    enterprise_id: "E0ORG",
    shared_team_ids: ["T0SIBLING", "T0HOME", "T0SIBLING"],
  });
  expect(facts).toMatchObject({ enterpriseId: "E0ORG", sharedTeamIds: ["T0HOME", "T0SIBLING"] });
});

test("a channel that leaves out its workspaces lists none, and names none it's in", () => {
  for (const absent of [undefined, null]) {
    const facts = slackConversationSchema.parse({
      ...privateChannel,
      context_team_id: absent,
      shared_team_ids: absent,
    });
    expect(facts).toMatchObject({ contextTeamId: null, sharedTeamIds: [] });
  }
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

test("a page of members lists their IDs and the cursor for the next page", () => {
  expect(
    channelMembersPageSchema.parse({
      ok: true,
      members: ["U0OWNER", "W0CAROL"],
      response_metadata: { next_cursor: "dXNlcjpVMEc5V0ZYTlo=" },
    }),
  ).toEqual({ members: ["U0OWNER", "W0CAROL"], nextCursor: "dXNlcjpVMEc5V0ZYTlo=" });
});

test("a page with nobody on it still has the next page's cursor", () => {
  expect(
    channelMembersPageSchema.parse({
      members: [],
      response_metadata: { next_cursor: "dXNlcjpVMEc5V0ZYTlo=" },
    }),
  ).toEqual({ members: [], nextCursor: "dXNlcjpVMEc5V0ZYTlo=" });
});

test("an empty or missing cursor ends the list, even after a page with nobody on it", () => {
  for (const response_metadata of [
    { next_cursor: "" },
    { next_cursor: null },
    {},
    null,
    undefined,
  ]) {
    expect(channelMembersPageSchema.parse({ members: [], response_metadata })).toEqual({
      members: [],
      nextCursor: null,
    });
  }
});

test("a page that doesn't list members as IDs is refused", () => {
  for (const members of [undefined, null, "U0OWNER", [""], [7]]) {
    expect(channelMembersPageSchema.safeParse({ members }).success).toBe(false);
  }
});
