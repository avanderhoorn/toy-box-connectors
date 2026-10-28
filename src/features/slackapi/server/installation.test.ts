import { expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { markAuthFailed, readInstallation } from "./installation";
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

function readAuthFailure(database: BridgeDatabase) {
  return database.read(async (sql) => {
    const [row] = await sql<{ status: string; auth_failed_at: number | null }[]>`
      SELECT status, auth_failed_at FROM installation
    `;
    return row;
  });
}

test("an active installation fails from the first rejection, and keeps that moment", async () => {
  const database = await openTestDatabase();
  await createStoredInstallation(database);

  expect(await database.write((transaction) => markAuthFailed(transaction, 1000))).toBe(true);
  expect(await database.write((transaction) => markAuthFailed(transaction, 2000))).toBe(false);
  expect(await readAuthFailure(database)).toEqual({ status: "auth_failed", auth_failed_at: 1000 });
});

test("an uninstalled installation, or none, isn't marked failed", async () => {
  const database = await openTestDatabase();
  expect(await database.write((transaction) => markAuthFailed(transaction, 1000))).toBe(false);

  await createStoredInstallation(database, { status: "uninstalled" });
  expect(await database.write((transaction) => markAuthFailed(transaction, 1000))).toBe(false);
  expect(await readAuthFailure(database)).toEqual({ status: "uninstalled", auth_failed_at: null });
});
