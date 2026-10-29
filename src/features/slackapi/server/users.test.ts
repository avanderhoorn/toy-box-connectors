import { expect, test } from "bun:test";
import { openTestDatabase } from "@bridge/server/testFixtures";
import { allowPerson, denyPeople } from "@links/server/database";
import { createStoredLink } from "@links/server/testFixtures";
import { slackPerson } from "@slackapi/model/testFixtures";
import {
  forgetUnallowedPeople,
  readPersonIds,
  readSlackPersonName,
  writeSlackPerson,
} from "./users";

test("the bridge forgets a person's name and other IDs once no link allows them", async () => {
  const database = await openTestDatabase();
  const links = ["link", "other"];
  for (const link of links) await createStoredLink(database, link);
  await database.write(async (transaction) => {
    await writeSlackPerson(transaction, slackPerson({ enterpriseUserId: "W-carol" }));
    for (const link of links) await allowPerson(transaction, link, "U-carol", 0);
  });
  const denyThenForget = async (link: string) => {
    await database.write(async (transaction) => {
      await denyPeople(transaction, link, ["U-carol"]);
      await forgetUnallowedPeople(transaction);
    });
    return database.read(async (sql) => ({
      name: await readSlackPersonName(sql, "W-carol"),
      ids: await readPersonIds(sql, "U-carol"),
    }));
  };

  expect(await denyThenForget("link")).toEqual({ name: "Carol Chen", ids: ["U-carol", "W-carol"] });
  expect(await denyThenForget("other")).toEqual({ name: null, ids: ["U-carol"] });
});
