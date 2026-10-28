import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { readInstallation } from "./installation";
import { createStoredInstallation } from "./testFixtures";

test("the installation reads back as it was stored", async () => {
  const database = await openTestDatabase();
  await createStoredInstallation(database, { enterprise_id: "E-org", status: "auth_failed" });

  expect(await database.read(readInstallation)).toEqual({
    teamId: "T-home",
    appId: "A-app",
    botId: "B-bot",
    botUserId: "U-bot",
    enterpriseId: "E-org",
    ownerUserId: "U-owner",
    status: "auth_failed",
  });
});

test("a standalone workspace has no org, and an unclaimed installation no owner", async () => {
  const database = await openTestDatabase();
  await createStoredInstallation(database, { owner_user_id: null });

  expect(await database.read(readInstallation)).toMatchObject({
    enterpriseId: null,
    ownerUserId: null,
  });
});

test("a bridge that never confirmed its tokens has no installation", async () => {
  const database = await openTestDatabase();

  expect(await database.read(readInstallation)).toBeNull();
});
