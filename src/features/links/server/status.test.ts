import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { privateAudience } from "@links/model/testFixtures";
import { allowPerson, denyPeople, readChannelLink } from "./database";
import { approveLink, deleteLink, pauseLink, suspendLink } from "./status";
import { countRows, createStoredLink } from "./testFixtures";

test("approving a link again makes it active with the new audience and settings", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database, "link", { status: "suspended", status_reason: "bot_removed" });
  const approved = { ...privateAudience(), kind: "public" } as const;
  const link = {
    toyBoxChannelId: "toybox-link",
    slackChannelId: "C-link",
    slackChannelName: "toy-box",
    approved,
  };
  const settings = { requestMode: "all", observe: "channel" } as const;
  await database.write((transaction) => approveLink(transaction, { ...link, ...settings }, 60_000));

  const stored = await database.read((sql) => readChannelLink(sql, "C-link"));
  expect(stored).toMatchObject({
    id: "link",
    slackChannelName: "toy-box",
    status: "active",
    ...settings,
    approved,
  });
});

test("a link whose Slack channel has a new ID stays suspended for that until unlink", async () => {
  const database = await openTestDatabase();
  await createStoredLink(database, "link", {
    status: "suspended",
    status_reason: "channel_id_changed",
  });

  const changed = await database.write(async (transaction) => {
    await pauseLink(transaction, "link", 60_000);
    return suspendLink(transaction, "link", "channel_not_found", 60_000);
  });

  expect(changed).toBe(false);
  expect(await database.read((sql) => sql`SELECT status, status_reason FROM links`)).toEqual([
    { status: "suspended", status_reason: "channel_id_changed" },
  ]);
});

test("deny, pause and unlink change only their link, and unlink deletes what it kept", async () => {
  const database = await openTestDatabase();
  for (const [id, people] of [
    ["gone", ["U-carol", "U-dave"]],
    ["kept", ["U-carol"]],
  ] as const) {
    await createStoredLink(database, id);
    await database.write(async (transaction) => {
      for (const userId of people) await allowPerson(transaction, id, userId, 0);
      await transaction`INSERT INTO cursors ${transaction({ link_id: id })}`;
      await transaction`INSERT INTO wakes ${transaction({ link_id: id, at: 0, outcome: "ran" })}`;
    });
  }

  await database.write(async (transaction) => {
    await denyPeople(transaction, "gone", ["U-carol"]);
    await pauseLink(transaction, "gone", 60_000);
  });
  const kept = await database.read((sql) => readChannelLink(sql, "C-kept"));
  await database.write((transaction) => deleteLink(transaction, "gone"));

  expect(kept?.status).toBe("active");
  expect(kept?.allowlist).toEqual(new Set(["U-carol"]));
  const counts = await countRows(database);
  expect(counts).toMatchObject({ allowlist: 1, cursors: 1, links: 1, wakes: 1 });
});
