import { expect, test } from "bun:test";
import { slackUserSchema } from "./users";

test("user facts preserve Enterprise identities and do not assume absent flags mean full membership", () => {
  const user = slackUserSchema.parse({
    id: "U1",
    team_id: "T1",
    enterprise_user: { id: "W1", enterprise_id: "E1" },
    profile: { display_name: "Alice", real_name: "Alice Smith" },
    future_field: true,
  });
  expect(user).toMatchObject({
    enterpriseId: "E1",
    enterpriseUserId: "W1",
    isBot: null,
    isRestricted: null,
    isUltraRestricted: null,
  });
});
