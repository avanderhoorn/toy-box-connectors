// Bridge startup and shutdown.
//
// At a terminal, `serve` first asks the owner for any Slack token or passphrase
// it's missing. The bridge then prepares its data folder, reads its settings,
// takes the single-bridge lock, and only then opens `bridge.db`, so a second
// bridge stops before it opens anything.
// Then it starts its work: forgetting old messages hourly, connecting to Slack
// once both tokens are set, waking leads, and answering commands on its socket.
// It lets go of everything in the reverse order, so it stops taking commands
// before anything they use stops.
//
// A part that fails in a way retrying can't fix, such as a storage error,
// reports it through one fatal path, and the bridge exits so launchd restarts
// it.

import { join } from "node:path";
import { forgetOldMessages } from "@activity/server/ledger";
import { askForMissingCredentials } from "@commands/client/firstRun";
import { installSkill } from "@commands/client/skill";
import { resolveSessionId } from "@commands/model/callers";
import { unconfiguredSlack, type SlackState } from "@commands/model/status";
import { activityCommand, markReadCommand } from "@commands/server/activity";
import { dismissCommand } from "@commands/server/dismiss";
import { inboxCommand } from "@commands/server/inbox";
import { publishCommand, replyCommand, retractCommand } from "@commands/server/posts";
import { serveCommands } from "@commands/server/serve";
import {
  allowCommand,
  denyCommand,
  linkCommand,
  pauseCommand,
  resumeCommand,
  unlinkCommand,
} from "@commands/server/setup";
import { statusCommand } from "@commands/server/status";
import { startOutboxWorker, type OutboxWorker } from "@outbox/server";
import { recoverOutboxAttempts } from "@outbox/server/database";
import { createBotClient, type BotClient } from "@slackapi/server/botClient";
import { wakeLead } from "@toybox/server";
import { readToyBoxChannel } from "@toybox/server/api";
import { startWakeScheduler, type WakeScheduler } from "@wakes/server";
import { log } from "@/shared/log";
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
    // Only the owner answers these, never a lead, whose shell can be a terminal too.
    if (process.stdin.isTTY && resolveSessionId(process.env) === null) {
      const saved = await askForMissingCredentials(dataFolder, process.env);
      if (saved) log(saved);
    }
    const bridge = await startBridge(dataFolder);
    // Whoever started the bridge may stop it as soon as it says it's running, so it listens first.
    const stopped = shutdownSignal(bridge.failed);
    // Only the bridge that holds the lock installs the skill, so leads read the one it ships.
    log(await refreshSkill());
    log(`toy-box-slack is running for ${dataFolder}`);

    const signal = await stopped;
    log(`toy-box-slack is stopping after ${signal ?? "an error"}`);
    await bridge.stop();
    return signal ? 0 : 1;
  } catch (error) {
    if (!(error instanceof BridgeRefusedError)) throw error;
    log(error.message);
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
  let outbox: OutboxWorker | undefined;
  let retention: Timer | undefined;

  async function stop() {
    clearInterval(retention);
    try {
      await socket?.stop();
      await scheduler?.stop();
      await outbox?.stop();
      await slack?.stop();
      await database?.close();
    } finally {
      await lock.release();
    }
  }

  try {
    database = await openBridgeDatabase(join(dataFolder, "bridge.db"));
    await database.write((tx) => recoverOutboxAttempts(tx, Date.now()));
    retention = await startRetention(database, failure.resolve);
    // Slack is supervised exactly when both tokens are set.
    const slackState = (): SlackState => unconfiguredSlack(settings) ?? slack!.state();
    const { botToken, appToken, slackApiUrl } = settings;
    let bot: BotClient | null = null;
    if (botToken && appToken) {
      bot = createBotClient(database, botToken, {
        slackApiUrl,
        onAuthFailed: (error) => slack?.botRejected(error),
      });
      slack = startSlackSupervisor(database, bot, {
        tokens: { botToken, appToken },
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
    if (bot) {
      outbox = startOutboxWorker(database, bot, {
        ready: () => slackState().connection === "connected",
        onChange: () => scheduler?.reconsider(),
        onError: failure.resolve,
      });
    }
    const workspaceUrl = () => slack?.workspaceUrl() ?? null;
    const setup = { database, bot, toyBoxOrigin: origin };
    socket = listenForCommands(
      commandSocketPath(dataFolder),
      serveCommands(
        database,
        {
          inbox: inboxCommand({
            database,
            workspaceUrl,
            acknowledge: (requests) => outbox?.acknowledge(requests),
          }),
          dismiss: dismissCommand({ database }),
          reply: replyCommand({ database, outbox }),
          activity: activityCommand({ database, workspaceUrl }),
          "mark-read": markReadCommand({ database }),
          publish: publishCommand({
            database,
            routines: async (channelId) =>
              (await readToyBoxChannel(origin, channelId))?.routines ?? null,
            outbox,
          }),
          retract: retractCommand({ database, bot }),
          status: statusCommand({
            database,
            slack: slackState,
            workspaceUrl,
            timings: settings.wakeTimings,
          }),
          link: linkCommand(setup),
          allow: allowCommand(setup),
          deny: denyCommand(setup),
          pause: pauseCommand(setup),
          resume: resumeCommand(setup),
          unlink: unlinkCommand(setup),
        },
        () => readCredentialsFile(dataFolder).OWNER_PASSPHRASE_HASH ?? null,
        () => scheduler?.reconsider(),
      ),
    );
    return { failed: failure.promise, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Forgets old messages now and then hourly, until the timer it returns is cleared. */
async function startRetention(
  database: BridgeDatabase,
  onError: (error: unknown) => void,
): Promise<Timer> {
  const forget = () => database.write((tx) => forgetOldMessages(tx, Date.now()));
  await forget();
  return setInterval(() => {
    forget().catch((error: unknown) => {
      log("Couldn't forget old messages:", error);
      onError(error);
    });
  }, 60 * 60_000);
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

/**
 * Installs the skill this release ships and says where. A failed install only says why, since the
 * bridge still stores what Slack sends while the owner fixes it.
 */
async function refreshSkill(): Promise<string> {
  try {
    return `Installed the toy-box-slack skill at ${await installSkill()}.`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `Couldn't install the toy-box-slack skill: ${reason}`;
  }
}
