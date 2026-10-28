// Bridge startup and shutdown.
//
// The bridge prepares its data folder, takes the single-bridge lock, and only
// then opens `bridge.db`, so a second bridge stops before it opens anything.
// It lets go of them in the reverse order.

import { join } from "node:path";
import { prepareDataFolder, resolveDataFolder } from "./dataFolder";
import { openBridgeDatabase } from "./database";
import { acquireBridgeLock } from "./lock";
import { BridgeRefusedError } from "./refusal";

export interface Bridge {
  stop(): Promise<void>;
}

/** Runs the bridge until SIGTERM or SIGINT and returns the process's exit code. */
export async function serveBridge(): Promise<number> {
  try {
    const dataFolder = resolveDataFolder();
    const bridge = await startBridge(dataFolder);
    console.error(`toy-box-slack is running for ${dataFolder}`);

    const signal = await shutdownSignal();
    console.error(`toy-box-slack is stopping after ${signal}`);
    await bridge.stop();
    return 0;
  } catch (error) {
    if (!(error instanceof BridgeRefusedError)) throw error;
    console.error(error.message);
    return 1;
  }
}

/** Starts the bridge for `dataFolder`, or refuses when it can't run there safely. */
export async function startBridge(dataFolder: string): Promise<Bridge> {
  prepareDataFolder(dataFolder);
  const lock = await acquireBridgeLock(join(dataFolder, "bridge.lock"));
  try {
    const database = await openBridgeDatabase(join(dataFolder, "bridge.db"));
    return {
      async stop() {
        try {
          await database.close();
        } finally {
          await lock.release();
        }
      },
    };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

/** Resolves with the first SIGTERM or SIGINT, after which a second one ends the process at once. */
function shutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const stop = (signal: NodeJS.Signals) => {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      resolve(signal);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });
}
