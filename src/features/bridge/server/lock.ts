// The single-bridge lock.
//
// One bridge owns a data folder. It holds an exclusive SQLite lock on
// `bridge.lock` through a connection that stays open for the bridge's whole
// life, so the operating system drops the lock when the process exits or
// crashes and a stale lock can't outlive its bridge. The bridge takes the lock
// before it opens `bridge.db`, so a second bridge stops without touching it.
//
// POSIX locks belong to the process, and closing any descriptor for a file
// drops every lock the process holds on it. SQLite tracks its own descriptors
// to avoid that, so nothing else may open `bridge.lock`.

import { dirname } from "node:path";
import { BridgeRefusedError } from "./refusal";

export interface BridgeLock {
  release(): Promise<void>;
}

/** Takes the lock at `path`, or refuses when another bridge holds it. */
export async function acquireBridgeLock(path: string): Promise<BridgeLock> {
  const connection = new Bun.SQL({ adapter: "sqlite", filename: path });
  try {
    await connection`PRAGMA locking_mode = EXCLUSIVE`;
    // In exclusive locking mode, the connection keeps the lock after this commits.
    await connection`BEGIN EXCLUSIVE`;
    await connection`COMMIT`;
  } catch (error) {
    await connection.close();
    if (error instanceof Bun.SQL.SQLiteError && error.code === "SQLITE_BUSY") {
      throw new BridgeRefusedError(
        `Another toy-box-slack bridge is already running for ${dirname(path)}. Stop it before starting a new one.`,
      );
    }
    throw error;
  }

  return { release: () => connection.close() };
}
