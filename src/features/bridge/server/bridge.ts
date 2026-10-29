// Bridge startup and shutdown.
//
// At a terminal, `serve` first asks the owner for any Slack token or passphrase
// it's missing. The bridge then prepares its data folder, reads its settings
// and every app's folder and tokens, and takes each app's lock, the default
// app's first, before it opens any app's `bridge.db`, so a second bridge stops
// before it opens anything. It opens every app before it starts any, so each
// `bridge.db` is open and recovered, and the bridge knows which Slack app each
// one records, before anything talks to Slack.
// Then it starts each app's work, and answers commands on its socket.
// It lets go of everything in the reverse order, so it stops taking commands
// before anything they use stops, and lets go of the default app's lock last.
//
// A part that fails in a way retrying can't fix, such as a storage error in
// any app, reports it through one fatal path, and the bridge exits with code 1,
// so a login job starts it afresh and an owner at a terminal sees why it
// stopped.

import { claimSlackApp, recordedHolders, type ClaimSlackApp } from "@bridge/model/claims";
import { askForMissingCredentials } from "@commands/client/firstRun";
import { installSkill } from "@commands/client/skill";
import { resolveSessionId } from "@commands/model/callers";
import { serveCommands } from "@commands/server/serve";
import { log } from "@/shared/log";
import { listApps, readAppTokens } from "./apps";
import { prepareDataFolder, resolveDataFolder } from "./dataFolder";
import { readCredentialsFile, resolveBridgeSettings } from "./environment";
import { openApp, type HostedApp } from "./hostedApp";
import { acquireBridgeLock, type BridgeLock } from "./lock";
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
    // Only the owner answers these, never a lead, whose shell can be a terminal too.
    if (process.stdin.isTTY && resolveSessionId(process.env) === null) {
      for (const saved of await askForMissingCredentials(dataFolder, process.env)) log(saved);
    }
    const bridge = await startBridge(dataFolder);
    // Nothing may await from here until the bridge says it's running, or Slack could log first.
    // Whoever started the bridge may stop it as soon as it says it's running, so it listens first.
    const stopped = shutdownSignal(bridge.failed);
    // Only the bridge that holds the lock installs the skill, so leads read the one it ships.
    log(refreshSkill());
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
  const listed = listApps(dataFolder).map((app) => ({ app, tokens: readAppTokens(app, env) }));
  const failure = Promise.withResolvers<unknown>();
  const locks: BridgeLock[] = [];
  const apps: HostedApp[] = [];
  let socket: CommandSocket | undefined;

  async function stop() {
    try {
      await socket?.stop();
      await settle(apps.map((app) => app.stop()));
    } finally {
      // A bridge starting meanwhile takes the default app's lock first, so it stops there.
      for (const lock of locks.toReversed()) await lock.release();
    }
  }

  try {
    for (const { app } of listed) locks.push(await acquireBridgeLock(app.lock));
    for (const { app, tokens } of listed) {
      apps.push(await openApp(app, tokens, { settings, onError: failure.resolve }));
    }
    const claims = slackAppClaims(apps);
    const running = apps.map((app) => app.start({ claim: claims(app.name) }));
    // listApps puts the default app first.
    const main = running[0]!;
    socket = listenForCommands(
      commandSocketPath(dataFolder),
      serveCommands(
        main.database,
        main.handlers,
        () => readCredentialsFile(dataFolder).OWNER_PASSPHRASE_HASH ?? null,
        () => main.onChange(),
      ),
    );
    return { failed: failure.promise, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Each app's claim on the Slack app Slack confirms its tokens for, where `apps` are in start order.
 * The claims share one record of which app holds each Slack app, for as long as the bridge runs.
 */
function slackAppClaims(apps: readonly HostedApp[]): (app: string) => ClaimSlackApp {
  let holders = recordedHolders(apps.map(({ name, slackAppId }) => ({ app: name, slackAppId })));
  return (app) => (slackAppId) => {
    const claimed = claimSlackApp(holders, slackAppId, app);
    holders = claimed.holders;
    return claimed.heldBy;
  };
}

/** Waits for all of `work` to finish, and then throws the first error any of it threw. */
async function settle(work: readonly Promise<void>[]): Promise<void> {
  for (const result of await Promise.allSettled(work)) {
    if (result.status === "rejected") throw result.reason;
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

/**
 * Installs the skill this release ships and says where. A failed install only says why, since the
 * bridge still stores what Slack sends while the owner fixes it.
 */
function refreshSkill(): string {
  try {
    return `Installed the toy-box-slack skill at ${installSkill()}.`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `Couldn't install the toy-box-slack skill: ${reason}`;
  }
}
