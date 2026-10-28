import { onTestFinished } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openBridgeDatabase, type BridgeDatabase } from "./database";

/**
 * Create an empty folder that's removed after the test. It sits directly in
 * /tmp because a Unix socket path inside it must stay under 104 bytes.
 */
export function createTestFolder(): string {
  const path = mkdtempSync("/tmp/tbs-");
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

/** Open a migrated `bridge.db` in a folder of its own, closed after the test. */
export async function openTestDatabase(): Promise<BridgeDatabase> {
  const database = await openBridgeDatabase(join(createTestFolder(), "bridge.db"));
  onTestFinished(() => database.close());
  return database;
}
