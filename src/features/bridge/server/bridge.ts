// Bridge startup and shutdown.
//
// The bridge prepares its data folder, reads its settings, takes the
// single-bridge lock, and only then opens `bridge.db`, so a second bridge stops
// before it opens anything.
// Then it starts its work: connecting to Slack once both tokens are set, waking
// leads, and answering commands on its socket. It lets go of everything in the
// reverse order, so it stops taking commands before anything they use stops.
//
// A part that fails in a way retrying can't fix, such as a storage error,
// reports it through one fatal path, and the bridge exits so launchd restarts
// it.

import { join } from "node:path";
import { unconfiguredSlack, type SlackState } from "@commands/model/status";
import { dismissCommand } from "@commands/server/dismiss";
import { inboxCommand } from "@commands/server/inbox";
import { serveCommands } from "@commands/server/serve";
import { statusCommand } from "@commands/server/status";
import { createBotClient } from "@slackapi/server/botClient";
import { wakeLead } from "@toybox/server";
import { startWakeScheduler, type WakeScheduler } from "@wakes/server";
import { prepareDataFolder, resolveDataFolder } from "./dataFolder";
import { openBridgeDatabase, type BridgeDatabase } from "./database";
import { readCredentialsFile, resolveBridgeSettings } from "./environment";
import { acquireBridgeLock } from "./lock";
import { BridgeRefusedError } from "./refusal";
import { startSlackSupervisor, type SlackSupervisor } from "./slack";
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
    // Whoever started the bridge may stop it as soon as it says it's running, so it listens first.
    const stopped = shutdownSignal(bridge.failed);
    console.error(`toy-box-slack is running for ${dataFolder}`);

    const signal = await stopped;
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
  let scheduler: WakeScheduler | undefined;
  let slack: SlackSupervisor | undefined;
  let socket: CommandSocket | undefined;

  async function stop() {
    try {
      await socket?.stop();
      await scheduler?.stop();
      await slack?.stop();
      await database?.close();
    } finally {
      await lock.release();
    }
  }

  try {
    database = await openBridgeDatabase(join(dataFolder, "bridge.db"));
    const filesFolder = join(dataFolder, "files");
    // Slack is supervised exactly when both tokens are set.
    const slackState = (): SlackState => unconfiguredSlack(settings) ?? slack!.state();
    const { botToken, appToken, slackApiUrl } = settings;
    if (botToken && appToken) {
      const bot = createBotClient(database, botToken, {
        slackApiUrl,
        onAuthFailed: (error) => slack?.botRejected(error),
      });
      slack = startSlackSupervisor(database, bot, {
        tokens: { botToken, appToken },
        filesFolder,
        slackApiUrl,
        onChange: () => scheduler?.reconsider(),
        onError: failure.resolve,
        timings: settings.wakeTimings,
      });
    }
    const origin = settings.toyBoxOrigin;
    scheduler = startWakeScheduler(database, (channelId) => wakeLead(origin, channelId), {
      onError: failure.resolve,
      timings: settings.wakeTimings,
    });
    socket = listenForCommands(
      commandSocketPath(dataFolder),
      serveCommands(database, {
        inbox: inboxCommand({
          database,
          wakes: scheduler,
          workspaceUrl: () => slack?.workspaceUrl() ?? null,
        }),
        dismiss: dismissCommand({ database, wakes: scheduler }),
        status: statusCommand({ database, slack: slackState, timings: settings.wakeTimings }),
      }),
    );
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
