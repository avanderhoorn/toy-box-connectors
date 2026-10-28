import { expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import {
  markAuthFailed,
  reactivateInstallation,
  readInstallation,
  recordInstallation,
} from "./installation";
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
    status: "auth_failed",
  });
});

test("a standalone workspace has no org", async () => {
  const database = await openTestDatabase();
  await createStoredInstallation(database);

  expect(await database.read(readInstallation)).toMatchObject({ enterpriseId: null });
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

test("the first identity Slack confirms is recorded active", async () => {
  const database = await openTestDatabase();
  const identity = {
    teamId: "T-home",
    enterpriseId: "E-org",
    appId: "A-app",
    botId: "B-bot",
    botUserId: "U-bot",
  };

  await database.write((transaction) => recordInstallation(transaction, identity));
  expect(await database.read(readInstallation)).toEqual({
    ...identity,
    status: "active",
  });
  expect(await readAuthFailure(database)).toEqual({ status: "active", auth_failed_at: null });
});

test("a failing installation is active again, and says when it began failing", async () => {
  const database = await openTestDatabase();
  await createStoredInstallation(database);
  await database.write((transaction) => markAuthFailed(transaction, 1000));

  expect(await database.write(reactivateInstallation)).toBe(1000);
  expect(await readAuthFailure(database)).toEqual({ status: "active", auth_failed_at: null });
  expect(await database.write(reactivateInstallation)).toBeNull();
});

test("only a failing installation is reactivated", async () => {
  const database = await openTestDatabase();
  expect(await database.write(reactivateInstallation)).toBeNull();

  await createStoredInstallation(database, { status: "uninstalled" });
  expect(await database.write(reactivateInstallation)).toBeNull();
  expect(await readAuthFailure(database)).toEqual({ status: "uninstalled", auth_failed_at: null });
});

test("a failure with no moment recorded counts from the epoch", async () => {
  const database = await openTestDatabase();
  await createStoredInstallation(database, { status: "auth_failed" });

  expect(await database.write(reactivateInstallation)).toBe(0);
  expect(await readAuthFailure(database)).toEqual({ status: "active", auth_failed_at: null });
});
