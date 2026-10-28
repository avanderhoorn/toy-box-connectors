import { expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "./testFixtures";

const OWNED_BY_LINK = ["allowlist", "coverage", "cursors", "link_routines", "wake_state"];
const OPEN_CLAIM_STATES = ["live", "posted"];
const CLOSED_CLAIM_STATES = ["confirmed", "declined", "void"];

function insertClaim(database: BridgeDatabase, state: string) {
  const claim = { code_hash: "hash", created_at: 0, expires_at: 600_000, state };
  return database.write((transaction) => transaction`INSERT INTO claims ${transaction(claim)}`);
}

function setClaimState(database: BridgeDatabase, from: string, to: string) {
  return database.write(
    (transaction) => transaction`UPDATE claims SET state = ${to} WHERE state = ${from}`,
  );
}

test("deleting a link deletes what belongs to it and nothing else", async () => {
  const database = await openTestDatabase();
  for (const id of ["gone", "kept"]) {
    await createStoredLink(database, id);
    await database.write(async (transaction) => {
      await transaction`INSERT INTO link_routines ${transaction({
        link_id: id,
        series: "release-notes",
        routine_id: `release-notes-${id}`,
        routine_state: "present",
        period: "week",
        schedule: "0 9 * * 1",
      })}`;
      await transaction`INSERT INTO allowlist ${transaction({ link_id: id, user_id: "U0123", added_at: 0 })}`;
      await transaction`INSERT INTO coverage ${transaction({
        link_id: id,
        channel_id: `C-${id}`,
        scope: "channel",
        oldest_ts: "1700000000.000100",
        latest_ts: "1700000600.000200",
        state: "open",
        reason: "reconnect",
        opened_at: 0,
      })}`;
      await transaction`INSERT INTO cursors ${transaction({ link_id: id })}`;
      await transaction`INSERT INTO wake_state ${transaction({ link_id: id })}`;
    });
  }

  await database.write((transaction) => transaction`DELETE FROM links WHERE id = 'gone'`);

  const remaining = await database.read(
    (sql) => sql`
      SELECT 'allowlist' AS name, link_id FROM allowlist
      UNION ALL SELECT 'coverage', link_id FROM coverage
      UNION ALL SELECT 'cursors', link_id FROM cursors
      UNION ALL SELECT 'link_routines', link_id FROM link_routines
      UNION ALL SELECT 'wake_state', link_id FROM wake_state
      ORDER BY name
    `,
  );
  expect([...remaining]).toEqual(OWNED_BY_LINK.map((name) => ({ name, link_id: "kept" })));
});

test("allow one open claim at a time, whether it's live or posted", async () => {
  const database = await openTestDatabase();
  await insertClaim(database, "void");

  for (const open of OPEN_CLAIM_STATES) {
    await insertClaim(database, open);
    for (const another of OPEN_CLAIM_STATES) {
      await expect(insertClaim(database, another)).rejects.toThrow(
        "UNIQUE constraint failed: index 'claims_one_open'",
      );
      await expect(setClaimState(database, "void", another)).rejects.toThrow(
        "UNIQUE constraint failed: index 'claims_one_open'",
      );
    }
    await setClaimState(database, open, "declined");
  }
});

test("allow a new claim once the open one is confirmed, declined or void", async () => {
  const database = await openTestDatabase();

  for (const closed of CLOSED_CLAIM_STATES) {
    await insertClaim(database, "live");
    await setClaimState(database, "live", "posted");
    await setClaimState(database, "posted", closed);
  }
  await insertClaim(database, "live");

  const states = await database.read((sql) => sql`SELECT state FROM claims ORDER BY id`);
  expect([...states].map((row) => row.state)).toEqual([...CLOSED_CLAIM_STATES, "live"]);
});
