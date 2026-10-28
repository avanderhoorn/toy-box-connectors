import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { privateAudience } from "@links/model/testFixtures";
import { readChannelLink, readChannelUses } from "./database";
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

test("a channel's uses say which links watch it, publish to it, or both", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database, "both", { slack_channel_id: "C-shared" });
  await createStoredLink(database, "publishes", { publish_channel_id: "C-shared" });
  await createStoredLink(database, "watches", {
    slack_channel_id: "C-shared-2",
    publish_channel_id: "C-other",
  });
  await createStoredLink(database, "elsewhere");

  expect(await database.read((sql) => readChannelUses(sql, "C-shared"))).toEqual([
    {
      linkId: "both",
      monitored: true,
      publish: true,
      approved: { monitored: privateAudience("C-shared"), publish: privateAudience("C-shared") },
    },
    {
      linkId: "publishes",
      monitored: false,
      publish: true,
      approved: {
        monitored: privateAudience("C-publishes"),
        publish: privateAudience("C-shared"),
      },
    },
  ]);
  expect(await database.read((sql) => readChannelUses(sql, "C-shared-2"))).toEqual([
    expect.objectContaining({ linkId: "watches", monitored: true, publish: false }),
  ]);
  expect(await database.read((sql) => readChannelUses(sql, "C-unlinked"))).toEqual([]);
});
