import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { readChannelLink } from "./database";
import { createStoredLink } from "./testFixtures";

test("a channel's link reads with its settings and the people it allows, whatever its status", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database, "link", {
    status: "paused",
    request_mode: "all",
    observe: "channel",
  });
  await createStoredLink(database, "other");
  await database.write(
    (transaction) => transaction`
      INSERT INTO allowlist (link_id, user_id, added_at)
      VALUES ('link', 'U-allowed', 0), ('link', 'U-also', 0), ('other', 'U-elsewhere', 0)
    `,
  );

  expect(await database.read((sql) => readChannelLink(sql, "C-link"))).toEqual({
    id: "link",
    status: "paused",
    requestMode: "all",
    observe: "channel",
    linkedAtTs: "1700000000.000100",
    allowlist: new Set(["U-allowed", "U-also"]),
  });
  expect(await database.read((sql) => readChannelLink(sql, "C-unlinked"))).toBeNull();
});
