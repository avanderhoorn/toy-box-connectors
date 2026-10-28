// Bridge startup and shutdown.
//
// The bridge prepares its data folder, takes the single-bridge lock, and only
// then opens `bridge.db`, so a second bridge stops before it opens anything.
// Then it starts its work: following each linked Toy Box channel and waking
// leads. It lets go of everything in the reverse order.
//
// A part that fails in a way retrying can't fix, such as a storage error,
// reports it through one fatal path, and the bridge exits so launchd restarts
// it.

import { join } from "node:path";
import { startToyBoxClient, type ToyBoxClient } from "@toybox/server";
import { startWakeScheduler, type WakeScheduler } from "@wakes/server";
import { prepareDataFolder, resolveDataFolder } from "./dataFolder";
import { openBridgeDatabase, type BridgeDatabase } from "./database";
import { resolveToyBoxOrigin, resolveWakeTimings } from "./environment";
import { acquireBridgeLock } from "./lock";
import { BridgeRefusedError } from "./refusal";

export interface Bridge {
  /** Resolves with the first error that stopped part of the bridge, after which it must stop. */
  readonly failed: Promise<unknown>;
  stop(): Promise<void>;
}

/** Runs the bridge until SIGTERM, SIGINT or a failure, and returns the process's exit code. */
export async function serveBridge(): Promise<number> {
  try {
    const dataFolder = resolveDataFolder();
    const bridge = await startBridge(dataFolder);
    console.error(`toy-box-slack is running for ${dataFolder}`);

    const signal = await shutdownSignal(bridge.failed);
    console.error(`toy-box-slack is stopping after ${signal ?? "an error"}`);
    await bridge.stop();
    return signal ? 0 : 1;
  } catch (error) {
    if (!(error instanceof BridgeRefusedError)) throw error;
    console.error(error.message);
    return 1;
  }
}

/**
 * Starts the bridge for `dataFolder` with the settings in `env`, or refuses when it can't run
 * there safely.
 */
export async function startBridge(
  dataFolder: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Bridge> {
  const origin = resolveToyBoxOrigin(env);
  const wakeTimings = resolveWakeTimings(env);
  prepareDataFolder(dataFolder);
  const lock = await acquireBridgeLock(join(dataFolder, "bridge.lock"));
  const failure = Promise.withResolvers<unknown>();
  let database: BridgeDatabase | undefined;
  let toyBox: ToyBoxClient | undefined;
  let scheduler: WakeScheduler | undefined;

  async function stop() {
    try {
      await scheduler?.stop();
      await toyBox?.stop();
      await database?.close();
    } finally {
      await lock.release();
    }
  }

  try {
    database = await openBridgeDatabase(join(dataFolder, "bridge.db"));
    toyBox = startToyBoxClient(database, {
      origin,
      onChange: () => scheduler?.reconsider(),
      onError: failure.resolve,
      timings: wakeTimings,
    });
    scheduler = startWakeScheduler(database, toyBox, {
      onError: failure.resolve,
      timings: wakeTimings,
    });
    await toyBox.followLinks();
    return { failed: failure.promise, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Resolves with the first SIGTERM or SIGINT, or with nothing once the bridge has failed. A signal
 * after that ends the process at once.
 */
function shutdownSignal(failed: Promise<unknown>): Promise<NodeJS.Signals | undefined> {
  return new Promise((resolve) => {
    const stop = (signal?: NodeJS.Signals) => {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      resolve(signal);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    void failed.then(() => stop());
  });
}
