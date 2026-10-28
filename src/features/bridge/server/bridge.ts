// Bridge startup and shutdown.
//
// The bridge prepares its data folder, reads its settings, takes the
// single-bridge lock, and only then opens `bridge.db`, so a second bridge stops
// before it opens anything.
// Then it starts its work: answering commands on its socket, following each
// linked Toy Box channel and waking leads. It lets go of everything in the
// reverse order, so it stops taking commands before anything they use stops.
//
// A part that fails in a way retrying can't fix, such as a storage error,
// reports it through one fatal path, and the bridge exits so launchd restarts
// it.

import { join } from "node:path";
import { commandContracts } from "@commands/model";
import { unconfiguredSlack, type SlackState } from "@commands/model/status";
import { serveCommands } from "@commands/server/serve";
import { statusCommand } from "@commands/server/status";
import { startToyBoxClient, type ToyBoxClient } from "@toybox/server";
import { startWakeScheduler, type WakeScheduler } from "@wakes/server";
import { prepareDataFolder, resolveDataFolder } from "./dataFolder";
import { openBridgeDatabase, type BridgeDatabase } from "./database";
import { readCredentialsFile, resolveBridgeSettings } from "./environment";
import { acquireBridgeLock } from "./lock";
import { BridgeRefusedError } from "./refusal";
import { commandSocketPath, listenForCommands, type CommandSocket } from "./socket";

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
  prepareDataFolder(dataFolder);
  const settings = resolveBridgeSettings(env, readCredentialsFile(dataFolder));
  const lock = await acquireBridgeLock(join(dataFolder, "bridge.lock"));
  const failure = Promise.withResolvers<unknown>();
  let database: BridgeDatabase | undefined;
  let toyBox: ToyBoxClient | undefined;
  let scheduler: WakeScheduler | undefined;
  let socket: CommandSocket | undefined;

  async function stop() {
    try {
      await socket?.stop();
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
      origin: settings.toyBoxOrigin,
      onChange: () => scheduler?.reconsider(),
      onError: failure.resolve,
      timings: settings.wakeTimings,
    });
    scheduler = startWakeScheduler(database, toyBox, {
      onError: failure.resolve,
      timings: settings.wakeTimings,
    });
    // Until the receiver reports its connection, Slack is on its way whenever both tokens are set.
    const slack = (): SlackState =>
      unconfiguredSlack(settings) ?? { connection: "connecting", problem: null };
    const origin = settings.toyBoxOrigin;
    socket = listenForCommands(
      commandSocketPath(dataFolder),
      serveCommands({
        contracts: commandContracts,
        handlers: {
          status: statusCommand({ database, origin, slack, toyBox, wakes: scheduler }),
        },
        database,
        origin,
        toyBox,
        slack,
      }),
    );
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
