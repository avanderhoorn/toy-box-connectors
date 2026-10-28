import { describe, expect, onTestFinished, test } from "bun:test";
import { join } from "node:path";
import { bridgeMigrations, openBridgeDatabase, type BridgeDatabase } from "@bridge/server/database";
import { createTestFolder, openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "./testFixtures";

const OWNED_BY_LINK = ["allowlist", "coverage", "cursors", "link_routines", "wake_state"];
const CLAIM_STATES = ["live", "posted", "admitted", "confirmed", "declined", "void"];
const OPEN_CLAIM_STATES = ["live", "posted", "admitted"];
const POSTED_CLAIM_STATES = ["posted", "admitted", "confirmed", "declined"];
const CLOSED_CLAIM_STATES = ["confirmed", "declined", "void"];
const APPROVAL_STATES = ["pending", "approved", "applied", "rejected", "expired", "stale"];
const POSTED = {
  posted_by: "U0123",
  posted_channel_id: "D0123",
  posted_ts: "1700000000.000100",
  posted_at: 60_000,
};
const UNPOSTED = { posted_by: null, posted_channel_id: null, posted_ts: null, posted_at: null };
let nextApprovalNumber = 1;

/** The columns a claim in `state` must carry, so only the check under test can refuse it. */
function claimIn(state: string) {
  return {
    state,
    ...(POSTED_CLAIM_STATES.includes(state) ? POSTED : UNPOSTED),
    decided_at: CLOSED_CLAIM_STATES.includes(state) ? 120_000 : null,
    void_reason: state === "void" ? "expired" : null,
  };
}

function insertClaim(database: BridgeDatabase, claim: Record<string, unknown>) {
  const row = { code_hash: "hash", created_at: 0, expires_at: 600_000, ...claim };
  return database.write((transaction) => transaction`INSERT INTO claims ${transaction(row)}`);
}

/** Store a claim, then delete it, so the one-open-claim index never decides the outcome. */
async function acceptsClaim(database: BridgeDatabase, claim: Record<string, unknown>) {
  await insertClaim(database, claim);
  await database.write((transaction) => transaction`DELETE FROM claims`);
}

function moveClaim(database: BridgeDatabase, from: string, to: string) {
  return database.write(
    (transaction) =>
      transaction`UPDATE claims SET ${transaction(claimIn(to))} WHERE state = ${from}`,
  );
}

/** The columns an approval in `state` must carry, so only the check under test can refuse it. */
function approvalIn(state: string) {
  const decided = ["approved", "applied", "rejected"].includes(state);
  return {
    state,
    stale_reason: state === "stale" ? "The link was paused." : null,
    applied_at: state === "applied" ? 180_000 : null,
    decided_by: decided ? "U0OWNER" : null,
    decided_at: decided ? 120_000 : null,
  };
}

function insertApproval(database: BridgeDatabase, approval: Record<string, unknown>) {
  const row = {
    id: crypto.randomUUID(),
    number: nextApprovalNumber++,
    toybox_channel_id: "toybox-link",
    link_id: "link",
    action: "allow",
    patch: "[]",
    read_set: "{}",
    owner_user_id: "U0OWNER",
    card_channel_id: "C-link",
    created_by: "lead",
    created_at: 0,
    expires_at: 600_000,
    ...approval,
  };
  return database.write((transaction) => transaction`INSERT INTO approvals ${transaction(row)}`);
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

describe("claims", () => {
  test("allow one open claim at a time, whether it's live, posted or admitted", async () => {
    const database = await openTestDatabase();
    await insertClaim(database, claimIn("void"));

    for (const open of OPEN_CLAIM_STATES) {
      await insertClaim(database, claimIn(open));
      for (const another of OPEN_CLAIM_STATES) {
        await expect(insertClaim(database, claimIn(another))).rejects.toThrow(
          "UNIQUE constraint failed: index 'claims_one_open'",
        );
        await expect(moveClaim(database, "void", another)).rejects.toThrow(
          "UNIQUE constraint failed: index 'claims_one_open'",
        );
      }
      await moveClaim(database, open, "declined");
    }
  });

  test("allow a new claim once the open one is confirmed, declined or void", async () => {
    const database = await openTestDatabase();

    for (const closed of CLOSED_CLAIM_STATES) {
      await insertClaim(database, claimIn("live"));
      await moveClaim(database, "live", "posted");
      await moveClaim(database, "posted", "admitted");
      await moveClaim(database, "admitted", closed);
    }
    await insertClaim(database, claimIn("live"));

    const states = await database.read((sql) => sql`SELECT state FROM claims ORDER BY id`);
    expect([...states].map((row) => row.state)).toEqual([...CLOSED_CLAIM_STATES, "live"]);
  });

  test("name who posted the code once it's posted, and never while live", async () => {
    const database = await openTestDatabase();
    const tie =
      "CHECK constraint failed: state = 'void'\n        OR (posted_by IS NOT NULL) = (state IN ('posted', 'admitted', 'confirmed', 'declined'))";

    for (const state of CLAIM_STATES) await acceptsClaim(database, claimIn(state));
    await acceptsClaim(database, { ...claimIn("void"), ...POSTED });
    await expect(insertClaim(database, { ...claimIn("live"), ...POSTED })).rejects.toThrow(tie);
    for (const state of POSTED_CLAIM_STATES) {
      await expect(insertClaim(database, { ...claimIn(state), ...UNPOSTED })).rejects.toThrow(tie);
    }
  });

  test("record who posted the code, in which message and when together", async () => {
    const database = await openTestDatabase();
    const together =
      "CHECK constraint failed: (posted_channel_id IS NULL) = (posted_by IS NULL)\n        AND (posted_ts IS NULL) = (posted_by IS NULL)\n        AND (posted_at IS NULL) = (posted_by IS NULL)";

    // A void claim may go either way, so only the pairing can refuse a partial one.
    for (const column of Object.keys(POSTED)) {
      await expect(
        insertClaim(database, { ...claimIn("void"), ...POSTED, [column]: null }),
      ).rejects.toThrow(together);
    }
  });

  test("have a decision time exactly once confirmed, declined or void", async () => {
    const database = await openTestDatabase();
    const tie =
      "CHECK constraint failed: (decided_at IS NOT NULL) = (state IN ('confirmed', 'declined', 'void'))";

    for (const state of OPEN_CLAIM_STATES) {
      await expect(insertClaim(database, { ...claimIn(state), decided_at: 1 })).rejects.toThrow(
        tie,
      );
    }
    for (const state of CLOSED_CLAIM_STATES) {
      await expect(insertClaim(database, { ...claimIn(state), decided_at: null })).rejects.toThrow(
        tie,
      );
    }
  });

  test("say why a claim is void exactly when it is", async () => {
    const database = await openTestDatabase();
    const tie = "CHECK constraint failed: (void_reason IS NOT NULL) = (state = 'void')";

    await expect(insertClaim(database, { ...claimIn("void"), void_reason: null })).rejects.toThrow(
      tie,
    );
    for (const state of CLAIM_STATES.filter((state) => state !== "void")) {
      await expect(
        insertClaim(database, { ...claimIn(state), void_reason: "expired" }),
      ).rejects.toThrow(tie);
    }
  });
});

describe("approvals", () => {
  test("accept the columns each state carries", async () => {
    const database = await openTestDatabase();

    for (const state of APPROVAL_STATES) await insertApproval(database, approvalIn(state));
    for (const state of ["expired", "stale"]) {
      await insertApproval(database, {
        ...approvalIn(state),
        decided_by: "U0OWNER",
        decided_at: 1,
      });
    }
  });

  test("give a stale reason exactly when stale and an applied time exactly when applied", async () => {
    const database = await openTestDatabase();
    const stale = "CHECK constraint failed: (stale_reason IS NOT NULL) = (state = 'stale')";
    const applied = "CHECK constraint failed: (applied_at IS NOT NULL) = (state = 'applied')";

    await expect(
      insertApproval(database, { ...approvalIn("stale"), stale_reason: null }),
    ).rejects.toThrow(stale);
    await expect(
      insertApproval(database, { ...approvalIn("expired"), stale_reason: "late" }),
    ).rejects.toThrow(stale);
    await expect(
      insertApproval(database, { ...approvalIn("applied"), applied_at: null }),
    ).rejects.toThrow(applied);
    await expect(
      insertApproval(database, { ...approvalIn("approved"), applied_at: 1 }),
    ).rejects.toThrow(applied);
  });

  test("record who decided and when together", async () => {
    const database = await openTestDatabase();
    const together = "CHECK constraint failed: (decided_at IS NULL) = (decided_by IS NULL)";

    // Expired and stale may go either way, so only the pairing can refuse half a decision.
    for (const state of ["expired", "stale"]) {
      await expect(
        insertApproval(database, { ...approvalIn(state), decided_by: "U0OWNER", decided_at: null }),
      ).rejects.toThrow(together);
      await expect(
        insertApproval(database, { ...approvalIn(state), decided_by: null, decided_at: 1 }),
      ).rejects.toThrow(together);
    }
  });

  test("record the decision once approved, applied or rejected, and never while pending", async () => {
    const database = await openTestDatabase();
    const tie =
      "CHECK constraint failed: state IN ('expired', 'stale')\n        OR (decided_by IS NOT NULL) = (state IN ('approved', 'applied', 'rejected'))";

    await expect(
      insertApproval(database, { ...approvalIn("pending"), decided_by: "U0OWNER", decided_at: 1 }),
    ).rejects.toThrow(tie);
    for (const state of ["approved", "applied", "rejected"]) {
      await expect(
        insertApproval(database, { ...approvalIn(state), decided_by: null, decided_at: null }),
      ).rejects.toThrow(tie);
    }
  });
});

describe("version 2 upgrades", () => {
  test("keep every approval as it was, and number the next after every approval there has been", async () => {
    const path = join(createTestFolder(), "bridge.db");
    const old = await openBridgeDatabase(path, bridgeMigrations.slice(0, 2));
    for (const [number, state] of [
      [1, "applied"],
      [2, "stale"],
    ] as const) {
      await insertApproval(old, {
        id: `approval-${number}`,
        number,
        card_ts: "1700000100.000100",
        ...approvalIn(state),
        reported_at: 240_000,
      });
    }
    const approvals = await old.read((sql) => sql`SELECT * FROM approvals ORDER BY number`);
    await old.close();

    const database = await openBridgeDatabase(path);
    onTestFinished(() => database.close());

    expect(await database.read((sql) => sql`SELECT * FROM approvals ORDER BY number`)).toEqual(
      approvals,
    );
    await database.write((transaction) => transaction`DELETE FROM approvals WHERE number = 2`);
    await insertApproval(database, {
      id: "approval-next",
      number: undefined,
      ...approvalIn("pending"),
    });
    expect(
      await database.read((sql) => sql`SELECT number FROM approvals WHERE id = 'approval-next'`),
    ).toEqual([{ number: 3 }]);
  });
});
