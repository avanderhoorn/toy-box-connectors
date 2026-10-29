import { onTestFinished } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { createBotClient } from "@slackapi/server/botClient";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startFakeSlack } from "../../../../tests/fakes/slack";
import { renderMarkdown } from "../model/rendering";
import { queueReply, readOutboxItem } from "./database";
import { createPostDelivery } from "./posts";

export function createStoredOutboxItem(
  database: BridgeDatabase,
  number: number,
  columns: Record<string, string | number | null> = {},
) {
  const rendered = renderMarkdown("An answer.");
  if (rendered.kind !== "rendered") throw new Error("Expected render");
  const payload = JSON.stringify(rendered.message);
  return database.write(
    (tx) =>
      tx`INSERT INTO outbox ${tx({
        id: `item-${number}`,
        number,
        link_id: "link",
        request_id: 1,
        kind: "reply",
        channel_id: "C-link",
        thread_ts: "1700000100.000100",
        payload,
        payload_hash: new Bun.CryptoHasher("sha256").update(payload).digest("hex"),
        state: "queued",
        created_at: 0,
        updated_at: 0,
        ...columns,
      })}`,
  );
}

export async function createOutboxWorld() {
  let at = 1_700_000_200_000;
  const now = () => at;
  const database = await openTestDatabase();
  const slack = startFakeSlack({
    now,
    identity: { teamId: "T-home", appId: "A-app", botId: "B-bot", botUserId: "U-bot" },
  });
  onTestFinished(() => slack.stop());
  slack.addChannel({
    id: "C-link",
    is_private: true,
    shared_team_ids: ["T-home"],
    members: ["U-owner", "U-bot"],
  });
  await createStoredInstallation(database);
  await createStoredLink(database);
  await database.write(
    (tx) => tx`
    INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-owner', 0)
  `,
  );
  const request = await createStoredRequest(database, {
    state: "seen",
    touchedAt: now(),
    expiresAt: now() + 604_800_000,
  });
  slack.setMessage("C-link", {
    type: "message",
    ts: request.sourceTs,
    user: "U-owner",
    text: "Question",
  });
  const bot = createBotClient(database, slack.botToken, {
    slackApiUrl: slack.url,
    timeoutMs: 50,
    now,
  });
  return {
    database,
    slack,
    bot,
    request,
    now,
    advance(ms: number) {
      at += ms;
    },
    queue: (text = "A **safe answer**.") =>
      database.write((tx) => queueReply(tx, { requestId: request.id, text }, now())),
    read: (id: string) => database.read((sql) => readOutboxItem(sql, id)),
    post: createPostDelivery(database, bot, { now }).post,
  };
}
