import { afterAll, describe, expect, test } from "bun:test";
import { WebClient } from "@slack/web-api";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { slackPerson as person } from "@slackapi/model/testFixtures";
import { canonicalUserId, fetchSlackPerson, readSlackPersonName, writeSlackPerson } from "./users";

/** What the fake users.info answers for each user ID it's asked about. */
const answers = new Map<string, unknown>([
  [
    "U-carol",
    {
      ok: true,
      user: {
        id: "U-carol",
        team_id: "T-home",
        real_name: "Carol",
        is_bot: false,
        is_restricted: false,
        is_ultra_restricted: false,
      },
    },
  ],
  ["U-gone", { ok: false, error: "user_not_found" }],
  ["U-broken", { ok: false, error: "invalid_auth" }],
  ["U-odd", { ok: true, user: { id: "" } }],
]);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const user = new URLSearchParams(await request.text()).get("user") ?? "";
    return Response.json(answers.get(user) ?? { ok: false, error: "unexpected" });
  },
});
afterAll(() => server.stop(true));

const client = new WebClient("xoxb-test", {
  slackApiUrl: `http://127.0.0.1:${server.port}/api/`,
  retryConfig: { retries: 0 },
});

describe("looking someone up", () => {
  test("reads who users.info says they are", async () => {
    expect(await fetchSlackPerson(client, "U-carol")).toEqual(
      person({ displayName: null, realName: "Carol" }),
    );
  });

  test("someone Slack doesn't know is no one", async () => {
    expect(await fetchSlackPerson(client, "U-gone")).toBeNull();
  });

  test("a lookup that fails, or answers with something that isn't a user, throws", async () => {
    await expect(fetchSlackPerson(client, "U-broken")).rejects.toThrow("invalid_auth");
    await expect(fetchSlackPerson(client, "U-odd")).rejects.toThrow();
  });
});

describe("keeping what Slack said about someone", () => {
  async function readUsers(database: BridgeDatabase) {
    return [...(await database.read((sql) => sql`SELECT * FROM users ORDER BY user_id`))];
  }

  test("keeps their workspace, org, names and account, as of the read", async () => {
    const database = await openTestDatabase();
    await database.write((transaction) => writeSlackPerson(transaction, person(), 1_000));

    expect(await readUsers(database)).toEqual([
      {
        user_id: "U-carol",
        team_id: "T-home",
        enterprise_id: null,
        display_name: "carol",
        real_name: "Carol Chen",
        is_bot: 0,
        deleted: 0,
        refreshed_at: 1_000,
      },
    ]);
  });

  test("a later read replaces an earlier one, and an earlier one never replaces a later one", async () => {
    const database = await openTestDatabase();
    await database.write(async (transaction) => {
      await writeSlackPerson(transaction, person(), 2_000);
      await writeSlackPerson(transaction, person({ deleted: true, displayName: "old" }), 1_000);
    });
    expect(await readUsers(database)).toMatchObject([{ deleted: 0, display_name: "carol" }]);

    await database.write((transaction) =>
      writeSlackPerson(transaction, person({ isWorkflowBot: true, displayName: "new" }), 3_000),
    );
    expect(await readUsers(database)).toMatchObject([
      { is_bot: 1, display_name: "new", refreshed_at: 3_000 },
    ]);
  });

  test("keeps a bot flag Slack left out as unknown", async () => {
    const database = await openTestDatabase();
    await database.write((transaction) =>
      writeSlackPerson(transaction, person({ isBot: null }), 1_000),
    );
    expect(await readUsers(database)).toMatchObject([{ is_bot: null }]);
  });

  test("a message or click carrying their org-wide ID counts as them", async () => {
    const database = await openTestDatabase();
    await database.write((transaction) =>
      writeSlackPerson(
        transaction,
        person({ enterpriseId: "E-org", enterpriseUserId: "W-carol" }),
        1_000,
      ),
    );

    await database.read(async (sql) => {
      expect(await canonicalUserId(sql, "W-carol")).toBe("U-carol");
      expect(await canonicalUserId(sql, "U-carol")).toBe("U-carol");
      expect(await canonicalUserId(sql, "U-stranger")).toBe("U-stranger");
    });
  });

  test("names them by their real name, else their display name, under either ID", async () => {
    const database = await openTestDatabase();
    await database.write(async (transaction) => {
      const carol = person({ enterpriseId: "E-org", enterpriseUserId: "W-carol" });
      await writeSlackPerson(transaction, carol, 1_000);
      await writeSlackPerson(transaction, person({ id: "U-dave", realName: null }), 1_000);
      const erin = person({ id: "U-erin", realName: null, displayName: null });
      await writeSlackPerson(transaction, erin, 1_000);
    });

    await database.read(async (sql) => {
      expect(await readSlackPersonName(sql, "U-carol")).toBe("Carol Chen");
      expect(await readSlackPersonName(sql, "W-carol")).toBe("Carol Chen");
      expect(await readSlackPersonName(sql, "U-dave")).toBe("carol");
      expect(await readSlackPersonName(sql, "U-erin")).toBeNull();
      expect(await readSlackPersonName(sql, "U-stranger")).toBeNull();
    });
  });

  test("someone whose IDs agree gets no alias", async () => {
    const database = await openTestDatabase();
    await database.write((transaction) =>
      writeSlackPerson(transaction, person({ enterpriseUserId: "U-carol" }), 1_000),
    );
    expect(await database.read((sql) => sql`SELECT * FROM user_aliases`)).toEqual([]);
  });
});
