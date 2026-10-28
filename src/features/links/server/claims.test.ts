import { describe, expect, test } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { CLAIM_LIFETIME_MS, hashClaimCode, MAX_CLAIM_ATTEMPTS } from "@links/model/claim";
import type { SlackPerson } from "@slackapi/model/users";
import { askMessage, slackPerson } from "@slackapi/model/testFixtures";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import {
  admitClaimPoster,
  answerStoredClaim,
  readClaimProgress,
  startClaim,
  takeClaim,
  type ClaimStart,
} from "./claims";

const POST_TS = "1700000100.000100";

/** Carol's post of `text` to the bot in a direct message. `changes` replace the message's fields. */
function claimPost(text: string, changes: Parameters<typeof askMessage>[1] = {}) {
  const exact = /^<@U-bot> claim (\S+)$/.exec(text);
  return {
    claim: { code: exact?.[1] ?? null },
    message: askMessage(POST_TS, { channelId: "D-carol", userId: "U-carol", text, ...changes }),
    edit: false,
    late: false,
  };
}

/** An installation with no owner yet, and a claim started at 0. */
async function openClaim(columns: Parameters<typeof createStoredInstallation>[1] = {}) {
  const database = await openTestDatabase();
  await createStoredInstallation(database, { owner_user_id: null, ...columns });
  const started = await database.write((transaction) => startClaim(transaction, 0));
  if (started.kind !== "started") throw new Error(`The claim didn't start: ${started.reason}`);
  return { database, ...started };
}

/**
 * A claim Carol posted the right code to at 60s, which the bridge then tried to admit at 70s with
 * what users.info said about her.
 */
async function admittedClaim(person: SlackPerson | null = slackPerson()) {
  const claim = await openClaim();
  await take(claim.database, claimPost(`<@U-bot> claim ${claim.code}`), 60_000);
  await claim.database.write((transaction) =>
    admitClaimPoster(transaction, claim.claimId, { person, readAt: 65_000 }, 70_000),
  );
  return claim;
}

function take(database: BridgeDatabase, posted: ReturnType<typeof claimPost>, now: number) {
  return database.write((transaction) => takeClaim(transaction, posted, now));
}

async function readClaims(database: BridgeDatabase) {
  return [
    ...(await database.read(
      (sql) => sql`
        SELECT id, state, failed_attempts, posted_by, posted_channel_id, posted_ts, decided_at,
          void_reason
        FROM claims ORDER BY id
      `,
    )),
  ];
}

async function readAudit(database: BridgeDatabase) {
  return [
    ...(await database.read((sql) => sql`SELECT actor, action, subject FROM audit ORDER BY id`)),
  ];
}

async function readOwner(database: BridgeDatabase) {
  const [row] = await database.read((sql) => sql`SELECT owner_user_id FROM installation`);
  return row.owner_user_id;
}

async function readOutbox(database: BridgeDatabase) {
  return [...(await database.read((sql) => sql`SELECT kind, channel_id, payload FROM outbox`))];
}

async function readUserIds(database: BridgeDatabase) {
  const rows = await database.read((sql) => sql`SELECT user_id FROM users ORDER BY user_id`);
  return [...rows].map((row) => row.user_id);
}

describe("starting a claim", () => {
  test("shows a new eight-digit code once and keeps only its hash", async () => {
    const database = await openTestDatabase();
    await createStoredInstallation(database, { owner_user_id: null });

    const started = await database.write((transaction) => startClaim(transaction, 1_000));

    expect(started).toEqual({
      kind: "started",
      claimId: 1,
      code: expect.stringMatching(/^\d{4}-\d{4}$/),
      expiresAt: 1_000 + CLAIM_LIFETIME_MS,
    });
    const { code } = started as Extract<ClaimStart, { kind: "started" }>;
    const [row] = await database.read((sql) => sql`SELECT * FROM claims`);
    expect(row).toMatchObject({ state: "live", code_hash: hashClaimCode(code) });
    expect(JSON.stringify(row)).not.toContain(code.replace("-", ""));
    expect(JSON.stringify(await readAudit(database))).not.toContain(code.slice(0, 4));
    expect(await readAudit(database)).toEqual([
      { actor: "operator", action: "start_claim", subject: null },
    ]);
  });

  test("voids the open claim it replaces, or records it expired once its deadline passed", async () => {
    const { database } = await openClaim();

    await database.write((transaction) => startClaim(transaction, 1_000));
    await database.write((transaction) => startClaim(transaction, 1_000 + CLAIM_LIFETIME_MS));

    expect(await readClaims(database)).toMatchObject([
      { id: 1, state: "void", decided_at: 1_000, void_reason: "replaced" },
      { id: 2, state: "void", decided_at: 1_000 + CLAIM_LIFETIME_MS, void_reason: "expired" },
      { id: 3, state: "live", void_reason: null },
    ]);
    expect((await readAudit(database)).map((entry) => entry.subject)).toEqual([
      null,
      "replaced",
      null,
      "expired",
      null,
    ]);
  });

  test("is refused once an owner is pinned, and while Slack isn't connected", async () => {
    const pinned = await openTestDatabase();
    await createStoredInstallation(pinned);
    const unconnected = await openTestDatabase();
    const failing = await openTestDatabase();
    await createStoredInstallation(failing, { owner_user_id: null, status: "auth_failed" });

    expect(await pinned.write((transaction) => startClaim(transaction, 0))).toEqual({
      kind: "refused",
      reason: "owner_pinned",
    });
    for (const database of [unconnected, failing]) {
      expect(await database.write((transaction) => startClaim(transaction, 0))).toEqual({
        kind: "refused",
        reason: "not_connected",
      });
    }
    for (const database of [pinned, unconnected, failing]) {
      expect(await readClaims(database)).toEqual([]);
    }
  });
});

describe("taking a claim message", () => {
  test("the right code from a person posts the claim, whatever workspace the message names", async () => {
    const { database, code } = await openClaim();

    const changed = await take(
      database,
      claimPost(`<@U-bot> claim ${code}`, { teamId: "T-sibling" }),
      60_000,
    );

    expect(changed).toBe(true);
    expect(await readClaims(database)).toEqual([
      {
        id: 1,
        state: "posted",
        failed_attempts: 0,
        posted_by: "U-carol",
        posted_channel_id: "D-carol",
        posted_ts: POST_TS,
        decided_at: null,
        void_reason: null,
      },
    ]);
    expect((await readAudit(database)).at(-1)).toEqual({
      actor: "bridge",
      action: "post_claim",
      subject: "U-carol",
    });
  });

  test("a wrong code counts against the claim, and the fifth voids it", async () => {
    const { database, code } = await openClaim();
    const wrong = code === "0000-0000" ? "0000-0001" : "0000-0000";

    for (let tries = 1; tries <= MAX_CLAIM_ATTEMPTS; tries += 1) {
      expect(await take(database, claimPost(`<@U-bot> claim ${wrong}`), tries)).toBe(true);
    }

    expect(await readClaims(database)).toMatchObject([
      { state: "void", failed_attempts: MAX_CLAIM_ATTEMPTS, void_reason: "exhausted" },
    ]);
    expect(await take(database, claimPost(`<@U-bot> claim ${code}`), 10)).toBe(false);
    expect((await readAudit(database)).slice(-2)).toEqual([
      { actor: "bridge", action: "miss_claim", subject: "U-carol" },
      { actor: "bridge", action: "void_claim", subject: "exhausted" },
    ]);
  });

  test("a post after the deadline voids the claim without trying the code", async () => {
    const { database, code } = await openClaim();

    expect(await take(database, claimPost(`<@U-bot> claim ${code}`), CLAIM_LIFETIME_MS)).toBe(true);

    expect(await readClaims(database)).toMatchObject([
      { state: "void", posted_by: null, void_reason: "expired" },
    ]);
  });

  test("edited, backfilled and bot-posted codes, and claims with extra words, change nothing", async () => {
    const { database, code } = await openClaim();
    const exact = claimPost(`<@U-bot> claim ${code}`);

    const attempts = [
      { ...exact, edit: true },
      { ...exact, late: true },
      { ...exact, message: { ...exact.message, author: "bot" as const } },
      { ...exact, message: { ...exact.message, subtype: "thread_broadcast" } },
      claimPost(`<@U-bot> claim ${code} please`),
    ];
    for (const attempt of attempts) expect(await take(database, attempt, 60_000)).toBe(false);

    expect(await readClaims(database)).toMatchObject([{ state: "live", failed_attempts: 0 }]);
    expect(await readAudit(database)).toHaveLength(1);
  });

  test("a code works once, so nobody can take over a posted claim", async () => {
    const { database, code } = await openClaim();
    await take(database, claimPost(`<@U-bot> claim ${code}`), 60_000);

    const again = claimPost(`<@U-bot> claim ${code}`, { userId: "U-mallory" });
    expect(await take(database, again, 61_000)).toBe(false);

    expect(await readClaims(database)).toMatchObject([{ state: "posted", posted_by: "U-carol" }]);
  });

  test("nothing is tried once an owner is pinned, or with no claim open", async () => {
    const { database, code } = await openClaim();
    await database.write(
      (transaction) => transaction`UPDATE installation SET owner_user_id = 'U-x'`,
    );
    expect(await take(database, claimPost(`<@U-bot> claim ${code}`), 60_000)).toBe(false);

    const idle = await openTestDatabase();
    await createStoredInstallation(idle, { owner_user_id: null });
    expect(await take(idle, claimPost(`<@U-bot> claim ${code}`), 60_000)).toBe(false);

    expect(await readClaims(database)).toMatchObject([{ state: "live" }]);
    expect(await readClaims(idle)).toEqual([]);
  });

  test("while Slack isn't connected, no code is tried", async () => {
    const { database, code } = await openClaim();
    await database.write(
      (transaction) => transaction`UPDATE installation SET status = 'auth_failed'`,
    );

    expect(await take(database, claimPost(`<@U-bot> claim ${code}`), 60_000)).toBe(false);
    expect(await take(database, claimPost("<@U-bot> claim 0000-0000"), 61_000)).toBe(false);

    expect(await readClaims(database)).toMatchObject([{ state: "live", failed_attempts: 0 }]);
    expect(await readAudit(database)).toMatchObject([{ action: "start_claim" }]);
  });
});

describe("admitting who posted the code", () => {
  test("someone the admission check passes is kept, so the terminal can name them", async () => {
    const { database, claimId } = await admittedClaim();

    expect(await readClaims(database)).toMatchObject([{ state: "admitted", void_reason: null }]);
    expect(await readUserIds(database)).toEqual(["U-carol"]);
    expect(await database.read((sql) => readClaimProgress(sql, claimId, 80_000))).toEqual({
      status: "admitted",
      failedAttempts: 0,
      expiresAt: CLAIM_LIFETIME_MS,
      post: { userId: "U-carol", channelId: "D-carol", ts: POST_TS, at: 60_000 },
      posterName: "Carol Chen",
      voidReason: null,
    });
    expect((await readAudit(database)).at(-1)).toEqual({
      actor: "bridge",
      action: "admit_claim",
      subject: "U-carol",
    });
  });

  test("someone it refuses voids the code, so it can't be posted again, and isn't kept", async () => {
    const refusals: [string, SlackPerson | null][] = [
      ["guest", slackPerson({ isRestricted: true })],
      ["guest", slackPerson({ isUltraRestricted: true })],
      ["bot", slackPerson({ isBot: true })],
      ["bot", slackPerson({ isWorkflowBot: true })],
      ["deactivated", slackPerson({ deleted: true })],
      ["other_workspace", slackPerson({ teamId: "T-other" })],
      ["unverified", slackPerson({ id: "U-mallory" })],
      ["user_not_found", null],
    ];
    for (const [problem, person] of refusals) {
      const { database, claimId, code } = await admittedClaim(person);

      expect(await readClaims(database)).toMatchObject([
        { id: claimId, state: "void", decided_at: 70_000, void_reason: problem },
      ]);
      expect(await readUserIds(database)).toEqual([]);
      expect((await readAudit(database)).at(-1)).toEqual({
        actor: "bridge",
        action: "void_claim",
        subject: problem,
      });
      expect(await take(database, claimPost(`<@U-bot> claim ${code}`), 80_000)).toBe(false);
    }
  });

  test("someone from another Enterprise org is refused", async () => {
    const { database, claimId, code } = await openClaim({ enterprise_id: "E-org" });
    await take(database, claimPost(`<@U-bot> claim ${code}`), 60_000);

    const outsider = slackPerson({ teamId: "T-far", enterpriseId: "E-far" });
    await database.write((transaction) =>
      admitClaimPoster(transaction, claimId, { person: outsider, readAt: 65_000 }, 70_000),
    );

    expect(await readClaims(database)).toMatchObject([{ state: "void", void_reason: "other_org" }]);
  });

  test("a claim that isn't waiting for admission doesn't change", async () => {
    const { database, claimId } = await openClaim();
    const refused = { person: slackPerson({ deleted: true }), readAt: 65_000 };
    expect(
      await database.write((transaction) =>
        admitClaimPoster(transaction, claimId, refused, 70_000),
      ),
    ).toBe(false);
    expect(await readClaims(database)).toMatchObject([{ state: "live" }]);

    const admitted = await admittedClaim();
    expect(
      await admitted.database.write((transaction) =>
        admitClaimPoster(transaction, admitted.claimId, refused, 75_000),
      ),
    ).toBe(false);
    expect(await readClaims(admitted.database)).toMatchObject([{ state: "admitted" }]);
  });

  test("while Slack isn't connected nobody is admitted", async () => {
    const { database, claimId, code } = await openClaim();
    await take(database, claimPost(`<@U-bot> claim ${code}`), 60_000);
    await database.write(
      (transaction) => transaction`UPDATE installation SET status = 'auth_failed'`,
    );

    const lookup = { person: slackPerson(), readAt: 65_000 };
    expect(
      await database.write((transaction) => admitClaimPoster(transaction, claimId, lookup, 70_000)),
    ).toBe(false);
    expect(await readClaims(database)).toMatchObject([{ state: "posted" }]);
    expect(await readUserIds(database)).toEqual([]);
  });

  test("past the deadline the claim goes void as expired instead", async () => {
    const { database, claimId, code } = await openClaim();
    await take(database, claimPost(`<@U-bot> claim ${code}`), 60_000);

    const lookup = { person: slackPerson(), readAt: CLAIM_LIFETIME_MS };
    await database.write((transaction) =>
      admitClaimPoster(transaction, claimId, lookup, CLAIM_LIFETIME_MS),
    );

    expect(await readClaims(database)).toMatchObject([{ state: "void", void_reason: "expired" }]);
    expect(await readUserIds(database)).toEqual([]);
  });
});

describe("answering a claim", () => {
  const yes = { confirm: true, postedBy: "U-carol" };
  const fresh = { person: slackPerson(), readAt: 85_000 };

  test("yes pins the person Slack names, queues ✅ on their message and audits it", async () => {
    const { database, claimId } = await admittedClaim();

    const answered = await database.write((transaction) =>
      answerStoredClaim(transaction, claimId, yes, fresh, 90_000),
    );

    expect(answered).toEqual({ kind: "confirmed", ownerUserId: "U-carol" });
    expect(await readOwner(database)).toBe("U-carol");
    expect(await readClaims(database)).toMatchObject([{ state: "confirmed", decided_at: 90_000 }]);
    expect(await readOutbox(database)).toEqual([
      {
        kind: "reaction",
        channel_id: "D-carol",
        payload: JSON.stringify({ action: "add", name: "white_check_mark", timestamp: POST_TS }),
      },
    ]);
    expect((await readAudit(database)).at(-1)).toEqual({
      actor: "operator",
      action: "pin_owner",
      subject: "U-carol",
    });
  });

  test("yes pins someone who posted under their org-wide ID by the user ID Slack gives them", async () => {
    const { database, claimId, code } = await openClaim({ enterprise_id: "E-org" });
    await take(database, claimPost(`<@U-bot> claim ${code}`, { userId: "W-carol" }), 60_000);
    const carol = slackPerson({ enterpriseId: "E-org", enterpriseUserId: "W-carol" });
    await database.write((transaction) =>
      admitClaimPoster(transaction, claimId, { person: carol, readAt: 65_000 }, 70_000),
    );

    const answered = await database.write((transaction) =>
      answerStoredClaim(
        transaction,
        claimId,
        { confirm: true, postedBy: "W-carol" },
        { person: carol, readAt: 85_000 },
        90_000,
      ),
    );

    expect(answered).toEqual({ kind: "confirmed", ownerUserId: "U-carol" });
    expect(await readOwner(database)).toBe("U-carol");
    expect(await database.read((sql) => sql`SELECT * FROM user_aliases`)).toEqual([
      { alias_id: "W-carol", user_id: "U-carol" },
    ]);
  });

  test("yes for someone a fresh read refuses voids the claim and pins no one", async () => {
    const { database, claimId } = await admittedClaim();

    const answered = await database.write((transaction) =>
      answerStoredClaim(
        transaction,
        claimId,
        yes,
        { person: slackPerson({ deleted: true }), readAt: 85_000 },
        90_000,
      ),
    );

    expect(answered).toEqual({ kind: "void", reason: "deactivated" });
    expect(await readOwner(database)).toBeNull();
    expect(await readClaims(database)).toMatchObject([
      { state: "void", void_reason: "deactivated" },
    ]);
    expect(await readOutbox(database)).toEqual([]);
  });

  test("no declines the claim and pins no one", async () => {
    const { database, claimId } = await admittedClaim();

    const answered = await database.write((transaction) =>
      answerStoredClaim(transaction, claimId, { ...yes, confirm: false }, null, 90_000),
    );

    expect(answered).toEqual({ kind: "declined" });
    expect(await readOwner(database)).toBeNull();
    expect(await readClaims(database)).toMatchObject([{ state: "declined", decided_at: 90_000 }]);
    expect((await readAudit(database)).at(-1)).toEqual({
      actor: "operator",
      action: "decline_claim",
      subject: "U-carol",
    });
    expect(await readOutbox(database)).toEqual([]);
  });

  test("an answer after the deadline voids the claim as expired", async () => {
    const { database, claimId } = await admittedClaim();

    const answered = await database.write((transaction) =>
      answerStoredClaim(transaction, claimId, yes, fresh, CLAIM_LIFETIME_MS),
    );

    expect(answered).toEqual({ kind: "void", reason: "expired" });
    expect(await readOwner(database)).toBeNull();
  });

  test("an answer about someone else, before admission, or for no claim changes nothing", async () => {
    const admitted = await admittedClaim();
    const answer = (database: BridgeDatabase, claimId: number, postedBy = "U-carol") =>
      database.write((transaction) =>
        answerStoredClaim(transaction, claimId, { confirm: true, postedBy }, fresh, 90_000),
      );

    expect(await answer(admitted.database, admitted.claimId, "U-mallory")).toEqual({
      kind: "refused",
      reason: "different_poster",
    });
    expect(await answer(admitted.database, 99)).toEqual({
      kind: "refused",
      reason: "unknown_claim",
    });
    const posted = await openClaim();
    await take(posted.database, claimPost(`<@U-bot> claim ${posted.code}`), 60_000);
    expect(await answer(posted.database, posted.claimId)).toEqual({
      kind: "refused",
      reason: "not_admitted",
    });

    expect(await readOwner(admitted.database)).toBeNull();
    expect(await readClaims(admitted.database)).toMatchObject([{ state: "admitted" }]);
  });

  test("while Slack isn't connected, an answer pins no one", async () => {
    const { database, claimId } = await admittedClaim();
    await database.write(
      (transaction) => transaction`UPDATE installation SET status = 'auth_failed'`,
    );

    const answered = await database.write((transaction) =>
      answerStoredClaim(transaction, claimId, yes, fresh, 90_000),
    );

    expect(answered).toEqual({ kind: "refused", reason: "not_connected" });
    expect(await readOwner(database)).toBeNull();
    expect(await readClaims(database)).toMatchObject([{ state: "admitted" }]);
    expect(await readOutbox(database)).toEqual([]);
  });

  test("once an owner is pinned, nothing can answer a claim", async () => {
    const { database, claimId } = await admittedClaim();
    await database.write((transaction) =>
      answerStoredClaim(transaction, claimId, yes, fresh, 90_000),
    );

    const again = await database.write((transaction) =>
      answerStoredClaim(transaction, claimId, { ...yes, confirm: false }, null, 91_000),
    );

    expect(again).toEqual({ kind: "refused", reason: "owner_pinned" });
    expect(await readClaims(database)).toMatchObject([{ state: "confirmed" }]);
  });
});

describe("following a claim", () => {
  test("an open claim past its deadline reads as expired before anything records it", async () => {
    const { database, claimId } = await openClaim();

    const progress = await database.read((sql) =>
      readClaimProgress(sql, claimId, CLAIM_LIFETIME_MS),
    );

    expect(progress).toEqual({
      status: "expired",
      failedAttempts: 0,
      expiresAt: CLAIM_LIFETIME_MS,
      post: null,
      posterName: null,
      voidReason: null,
    });
    expect(await database.read((sql) => readClaimProgress(sql, 99, 0))).toBeNull();
  });

  test("a void claim says why", async () => {
    const { database, claimId } = await admittedClaim(slackPerson({ isRestricted: true }));

    const progress = await database.read((sql) => readClaimProgress(sql, claimId, 80_000));

    expect(progress).toMatchObject({ status: "void", voidReason: "guest", posterName: null });
  });
});
