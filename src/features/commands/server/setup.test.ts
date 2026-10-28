import { expect, test } from "bun:test";
import { createStoredMessage, ledgerLink } from "@activity/server/testFixtures";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { countRows, createStoredLink, fillEveryTable } from "@links/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { askMessage } from "@slackapi/model/testFixtures";
import { unlinkCommand } from "./setup";

test("unlink deletes what the bridge kept for its link, and nothing of another link's", async () => {
  const database = await openTestDatabase();
  await fillEveryTable(database);
  const before = await countRows(database);
  await createStoredLink(database, "gone");
  const message = askMessage(undefined, { channelId: "C-gone" });
  await createStoredMessage(database, message, { ...ledgerLink(), id: "gone" });
  await createStoredRequest(database, { linkId: "gone", channelId: "C-gone" });
  const unlink = unlinkCommand({
    database,
    bot: null,
    toyBoxOrigin: new URL("http://127.0.0.1"),
    wakes: { reconsider: () => {} },
  });

  await unlink({}, { caller: { role: "lead", channelId: "toybox-gone" }, at: 1_000 });

  expect(await countRows(database)).toEqual(before);
});
