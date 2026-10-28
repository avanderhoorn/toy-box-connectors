import { expect, test } from "bun:test";
import { slackConversationSchema } from "./channels";

test("audience facts retain Enterprise sharing and fail closed on missing sharing flags", () => {
  const channel = {
    id: "C1",
    is_private: true,
    is_member: true,
    is_archived: false,
    is_ext_shared: false,
    is_pending_ext_shared: false,
    is_org_shared: true,
    enterprise_id: "E1",
    shared_team_ids: ["T2", "T1", "T2"],
  };
  expect(slackConversationSchema.parse(channel)).toMatchObject({
    kind: "private",
    isOrgShared: true,
    enterpriseId: "E1",
    sharedTeamIds: ["T1", "T2"],
  });
  for (const field of ["is_archived", "is_ext_shared", "is_pending_ext_shared", "is_org_shared"]) {
    expect(slackConversationSchema.safeParse({ ...channel, [field]: undefined }).success).toBe(
      false,
    );
  }
});
