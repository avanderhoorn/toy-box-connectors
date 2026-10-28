import { describe, expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { slackPerson } from "@slackapi/model/testFixtures";
import { writeSlackPerson } from "@slackapi/server/users";
import { recordCardPosted } from "./approvals";
import { readApprovalCard } from "./cards";
import { createStoredApproval, createStoredLink } from "./testFixtures";

describe("reading an approval's card", () => {
  test("shows each person by the name the bridge stored, or by their ID when it has none", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    await createStoredApproval(database, {
      patch: [
        { field: "allowlist.U0CAROL", after: { label: null } },
        { field: "allowlist.U0DEV", after: { label: null } },
        { field: "allowlist.U0ERIN", after: { label: null } },
      ],
    });
    await database.write(async (transaction) => {
      await writeSlackPerson(transaction, slackPerson({ id: "U0CAROL" }), 0);
      await writeSlackPerson(
        transaction,
        slackPerson({ id: "U0DEV", realName: null, displayName: "dev" }),
        0,
      );
    });

    const card = await database.read((sql) => readApprovalCard(sql, "approval-1"));

    expect(card?.channelId).toBe("C-link");
    expect(card?.ts).toBe("1000.000100");
    expect(card?.message.blocks[1]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "• Allows Carol Chen (`U0CAROL`)\n• Allows dev (`U0DEV`)\n• Allows `U0ERIN`\n• C-link is a private channel",
        verbatim: true,
      },
    });
  });

  test("renders the approval as it is when read, with the ts once the post is recorded", async () => {
    const database = await openTestDatabase();
    await createStoredLink(database);
    await createStoredApproval(database, { card: { channelId: "C-link", ts: null } });

    const posted = await database.read((sql) => readApprovalCard(sql, "approval-1"));
    expect(posted?.ts).toBeNull();
    expect(posted?.message.blocks.map((block) => block.type)).toContain("actions");

    await database.write(async (transaction) => {
      await recordCardPosted(transaction, "approval-1", "1000.000200");
      await transaction`
        UPDATE approvals SET state = 'rejected', decided_by = 'U-owner', decided_at = 5
        WHERE id = 'approval-1'
      `;
    });
    const updated = await database.read((sql) => readApprovalCard(sql, "approval-1"));

    expect(updated?.ts).toBe("1000.000200");
    expect(updated?.message.blocks.map((block) => block.type)).not.toContain("actions");
    expect(updated?.message.blocks.at(-1)).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "a1 · Rejected by U-owner", verbatim: true }],
    });
  });

  test("an approval that's gone has no card, so the outbox drops it", async () => {
    const database = await openTestDatabase();

    expect(await database.read((sql) => readApprovalCard(sql, "approval-1"))).toBeNull();
  });
});
