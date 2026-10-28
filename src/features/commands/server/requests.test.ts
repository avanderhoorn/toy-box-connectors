import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import type { ChannelCaller } from "@commands/model/callers";
import { notLinked } from "@commands/model/unlinked";
import { readCallerRequest } from "./requests";

const callers: [string, ChannelCaller][] = [
  ["the lead", { role: "lead", channelId: "toybox-unlinked", sessionId: "lead-session" }],
  ["a member", { role: "member", channelId: "toybox-unlinked", sessionId: "member-session" }],
  ["the operator", { role: "operator", channelId: "toybox-unlinked", sessionId: null }],
];

test.each(callers)(
  "tells %s in a channel with no link what it may do about that",
  async (_, caller) => {
    const database = await openTestDatabase();

    await expect(database.read((sql) => readCallerRequest(sql, caller, 14))).rejects.toMatchObject({
      rule: "not_linked",
      message: notLinked(caller.role, "so it has no r14"),
    });
  },
);
