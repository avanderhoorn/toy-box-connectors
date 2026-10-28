import { expect, onTestFinished, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder, openTestDatabase } from "@bridge/server/testFixtures";
import { forgetFile, removeLocalCopies, syncMessageFiles } from "./files";

test("forgetting a file Slack deleted hands back its local copy, if the bridge fetched one", async () => {
  const database = await openTestDatabase();
  await database.write(async (transaction) => {
    await syncMessageFiles(transaction, "C-link", "1700000100.000100", [
      { id: "F1", name: "a.png", mimetype: "image/png", size: 1 },
      { id: "F2", name: "b.png", mimetype: "image/png", size: 1 },
    ]);
    await transaction`
      UPDATE files SET state = 'fetched', local_path = 'F2.png', fetched_at = 1
      WHERE file_id = 'F2'
    `;
  });

  const forget = (fileId: string) =>
    database.write((transaction) => forgetFile(transaction, fileId));
  expect(await forget("F1")).toEqual([]);
  expect(await forget("F2")).toEqual(["F2.png"]);
  expect(await forget("F2")).toBeNull();
  expect(await forget("F-never")).toBeNull();
});

test("removing local copies leaves anything outside the files folder alone", async () => {
  const dataFolder = createTestFolder();
  const filesFolder = join(dataFolder, "files");
  mkdirSync(join(filesFolder, "nested"), { recursive: true });
  for (const path of ["files/F1.png", "files/nested/F2.png", "files/..F3.png", "bridge.db"]) {
    writeFileSync(join(dataFolder, path), "");
  }
  const log = spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());

  await removeLocalCopies(filesFolder, [
    "F1.png",
    "nested/F2.png",
    "..F3.png",
    "F-gone.png",
    "../bridge.db",
    join(dataFolder, "bridge.db"),
    "..",
    ".",
  ]);
  expect(existsSync(join(filesFolder, "F1.png"))).toBe(false);
  expect(existsSync(join(filesFolder, "nested/F2.png"))).toBe(false);
  expect(existsSync(join(filesFolder, "..F3.png"))).toBe(false);
  expect(existsSync(join(dataFolder, "bridge.db"))).toBe(true);
  expect(existsSync(filesFolder)).toBe(true);
  expect(log.mock.calls).toEqual(
    Array(4).fill(["Kept a file the ledger forgot because its path leaves the files folder."]),
  );
});
