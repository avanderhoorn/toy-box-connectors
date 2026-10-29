import { onTestFinished, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { locateApp, type App } from "./apps";
import { openBridgeDatabase, type BridgeDatabase } from "./database";
import { writeCredential, type AppCredentials } from "./environment";
import { BridgeRefusedError } from "./refusal";

/** Create an empty folder that's removed after the test. */
export function createTestFolder(): string {
  const path = mkdtempSync("/tmp/tbs-");
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

/** Make the folder of an app `add-app` adds to `dataFolder`, holding just `credentials`. */
export function createAddedApp(
  dataFolder: string,
  name: string,
  credentials: AppCredentials = {},
): App {
  const app = locateApp(dataFolder, name);
  mkdirSync(app.folder, { recursive: true, mode: 0o700 });
  for (const [setting, value] of Object.entries(credentials)) {
    writeCredential(app.folder, setting as keyof AppCredentials, value);
  }
  return app;
}

/** The whole message `operation` refuses with. */
export function refusalOf(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    if (error instanceof BridgeRefusedError) return error.message;
    throw error;
  }
  throw new Error("Expected a refusal.");
}

/** Open a new `bridge.db` in a folder of its own, closed after the test. */
export async function openTestDatabase(): Promise<BridgeDatabase> {
  const database = await openBridgeDatabase(join(createTestFolder(), "bridge.db"));
  onTestFinished(() => database.close());
  return database;
}

/** Leave a `bridge.db` at `path` that says `version` of the bridge made it. */
export async function createDatabaseMadeBy(path: string, version: number): Promise<void> {
  const sql = new Bun.SQL({ adapter: "sqlite", filename: path });
  await sql.unsafe(`PRAGMA user_version = ${version}`);
  await sql.close();
}

/** Keep what the test logs, unprinted, as a string for each `log` without its newline. */
export function captureLog(): () => string[] {
  const write = spyOn(process.stderr, "write").mockImplementation(() => true);
  onTestFinished(() => write.mockRestore());
  return () => write.mock.calls.map(([text]) => String(text).replace(/\n$/, ""));
}
