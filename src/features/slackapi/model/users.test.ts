import { expect, test } from "bun:test";
import { personIds, slackUserSchema } from "./users";

/** A full member as users.info returns them, with fields the bridge doesn't keep. */
const member = {
  id: "U0MEMBER",
  team_id: "T0HOME",
  name: "ada",
  deleted: false,
  color: "9f69e7",
  real_name: "Ada Lovelace",
  tz: "Europe/London",
  profile: {
    display_name: "ada",
    real_name: "Ada Lovelace",
    image_48: "https://example.com/a.png",
  },
  is_admin: false,
  is_owner: false,
  is_primary_owner: false,
  is_restricted: false,
  is_ultra_restricted: false,
  is_bot: false,
  is_app_user: false,
  is_workflow_bot: false,
  updated: 1700000000,
};

test("a member reads as who they are, their account and their workspace", () => {
  expect(slackUserSchema.parse(member)).toEqual({
    id: "U0MEMBER",
    teamId: "T0HOME",
    enterpriseId: null,
    enterpriseUserId: null,
    isBot: false,
    isWorkflowBot: false,
    deleted: false,
    isRestricted: false,
    isUltraRestricted: false,
    displayName: "ada",
    realName: "Ada Lovelace",
  });
});

test("an Enterprise member names their org and their ID across it", () => {
  const person = slackUserSchema.parse({
    ...member,
    enterprise_user: {
      id: "W0MEMBER",
      enterprise_id: "E0ORG",
      enterprise_name: "Org",
      is_admin: false,
      teams: ["T0HOME", "T0SIBLING"],
    },
  });
  expect(person).toMatchObject({ enterpriseId: "E0ORG", enterpriseUserId: "W0MEMBER" });
  expect(personIds(person)).toEqual(["U0MEMBER", "W0MEMBER"]);
});

test("someone whose IDs agree, or who has only one, is known by one ID", () => {
  expect(personIds(slackUserSchema.parse(member))).toEqual(["U0MEMBER"]);
  expect(
    personIds(
      slackUserSchema.parse({
        ...member,
        enterprise_user: { id: "U0MEMBER", enterprise_id: "E0ORG" },
      }),
    ),
  ).toEqual(["U0MEMBER"]);
});

test("each account flag reads as Slack set it", () => {
  const flags = {
    is_bot: "isBot",
    is_workflow_bot: "isWorkflowBot",
    deleted: "deleted",
    is_restricted: "isRestricted",
    is_ultra_restricted: "isUltraRestricted",
  } as const;
  for (const [flag, field] of Object.entries(flags)) {
    const person = slackUserSchema.parse({ ...member, [flag]: true });
    for (const other of Object.values(flags)) expect(person[other]).toBe(other === field);
  }
});

test("a flag Slack leaves out reads as unset, as Slack documents for deleted", () => {
  const {
    deleted: _deleted,
    is_bot: _isBot,
    is_workflow_bot: _isWorkflowBot,
    is_restricted: _isRestricted,
    is_ultra_restricted: _isUltraRestricted,
    ...bare
  } = member;
  expect(slackUserSchema.parse(bare)).toMatchObject({
    isBot: false,
    isWorkflowBot: false,
    deleted: false,
    isRestricted: false,
    isUltraRestricted: false,
  });
});

test("a workspace or org Slack leaves out stays unknown rather than assumed", () => {
  const { team_id: _teamId, ...withoutTeam } = member;
  expect(slackUserSchema.parse(withoutTeam)).toMatchObject({ teamId: null, enterpriseId: null });
  expect(slackUserSchema.parse({ ...member, enterprise_user: { id: "W0MEMBER" } })).toMatchObject({
    enterpriseId: null,
    enterpriseUserId: "W0MEMBER",
  });
});

test("an empty display name falls back to no name, and a missing real name to the profile's", () => {
  expect(
    slackUserSchema.parse({ ...member, profile: { display_name: "", real_name: "Ada" } }),
  ).toMatchObject({ displayName: null, realName: "Ada Lovelace" });
  const { real_name: _realName, ...withoutRealName } = member;
  expect(
    slackUserSchema.parse({ ...withoutRealName, profile: { display_name: "", real_name: "Ada" } }),
  ).toMatchObject({ displayName: null, realName: "Ada" });
  expect(slackUserSchema.parse({ ...withoutRealName, profile: null })).toMatchObject({
    displayName: null,
    realName: null,
  });
});

test("a user without an ID, or with a flag of the wrong type, is refused", () => {
  expect(slackUserSchema.safeParse({ ...member, id: "" }).success).toBe(false);
  expect(slackUserSchema.safeParse({ ...member, is_bot: "false" }).success).toBe(false);
  expect(slackUserSchema.safeParse({ ...member, team_id: "" }).success).toBe(false);
});
