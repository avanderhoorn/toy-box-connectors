import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "./testFixtures";

const OWNED_BY_LINK = ["allowlist", "coverage", "cursors", "link_routines", "wake_state"];

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
        registered_at: 0,
      })}`;
      await transaction`INSERT INTO allowlist ${transaction({ link_id: id, user_id: "U0123", added_at: 0 })}`;
      await transaction`INSERT INTO coverage ${transaction({
        link_id: id,
        channel_id: `C-${id}`,
        scope: "channel",
        oldest_ts: "1700000000.000100",
        latest_ts: "1700000600.000200",
        state: "open",
        reason: "disconnect",
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
