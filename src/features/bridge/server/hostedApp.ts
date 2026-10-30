// One app the bridge hosts.
//
// An app is one Slack app's tokens and the bridge.db that holds what came through it, and the bridge
// runs the same parts for each: forgetting hourly what it no longer keeps, connecting to Slack once
// both tokens are set, sending the outbox, waking the leads its links name, and the commands those
// leads run. An app opens before it starts, so the bridge can open and recover every bridge.db, and
// learn which Slack app each one records, before any app talks to Slack.
//
// The default app's lines in the bridge's log read as they did before the bridge hosted several,
// and an added app's start with its name. What its commands say names it once the bridge hosts
// several.

import { DEFAULT_APP } from "@bridge/model/apps";
import type { ClaimSlackApp } from "@bridge/model/claims";
import { unconfiguredSlack, type SlackState } from "@commands/model/status";
import { activityCommand, markReadCommand } from "@commands/server/activity";
import { dismissCommand } from "@commands/server/dismiss";
import { inboxCommand } from "@commands/server/inbox";
import { publishCommand, replyCommand, retractCommand } from "@commands/server/posts";
import type { ServedApp } from "@commands/server/serve";
import {
  allowCommand,
  denyCommand,
  linkCommand,
  pauseCommand,
  resumeCommand,
  unlinkCommand,
} from "@commands/server/setup";
import { startOutboxWorker, type OutboxWorker } from "@outbox/server";
import { recoverOutboxAttempts } from "@outbox/server/database";
import { createBotClient, type BotClient } from "@slackapi/server/botClient";
import { readInstallation } from "@slackapi/server/installation";
import { wakeLead } from "@toybox/server";
import { readToyBoxChannel } from "@toybox/server/api";
import { startWakeScheduler, type WakeScheduler } from "@wakes/server";
import { labeledLog, log as bridgeLog } from "@/shared/log";
import type { App, AppTokens } from "./apps";
import { openBridgeDatabase } from "./database";
import type { BridgeSettings } from "./environment";
import { startRetention } from "./retention";
import { startSlackSupervisor, type SlackSupervisor } from "./slack";

/** An app whose bridge.db is open and recovered. */
export interface HostedApp {
  readonly name: string;
  /** The Slack app its bridge.db records, or null before Slack first confirmed its tokens. */
  readonly slackAppId: string | null;
  /**
   * Starts its work, connecting to Slack only through a Slack app `claim` gives it, and answers
   * what its commands reach. They name the app when `nameApps` says the bridge hosts several.
   */
  start(options: { claim: ClaimSlackApp; nameApps: boolean }): ServedApp;
  /** Stops whatever it started, and then closes its bridge.db. */
  stop(): Promise<void>;
}

/**
 * Opens `app` and recovers its bridge.db. Its work reports a failure retrying can't fix, such as
 * storage failing, through `onError`.
 */
export async function openApp(
  app: App,
  tokens: AppTokens,
  { settings, onError }: { settings: BridgeSettings; onError: (error: unknown) => void },
): Promise<HostedApp> {
  const log = app.name === DEFAULT_APP ? bridgeLog : labeledLog(app.name);
  const database = await openBridgeDatabase(app.database);
  let retention: Timer | undefined;
  let slackAppId: string | null;
  try {
    await database.write((tx) => recoverOutboxAttempts(tx, Date.now()));
    retention = await startRetention(database, onError, log);
    slackAppId = (await database.read(readInstallation))?.appId ?? null;
  } catch (error) {
    clearInterval(retention);
    await database.close();
    throw error;
  }
  let scheduler: WakeScheduler | undefined;
  let slack: SlackSupervisor | undefined;
  let outbox: OutboxWorker | undefined;

  function start({ claim, nameApps }: { claim: ClaimSlackApp; nameApps: boolean }): ServedApp {
    // Slack is supervised exactly when both tokens are set.
    const slackState = (): SlackState => unconfiguredSlack(tokens, app.name) ?? slack!.state();
    const { botToken, appToken } = tokens;
    const { slackApiUrl, toyBoxOrigin: origin, wakeTimings: timings } = settings;
    let bot: BotClient | null = null;
    if (botToken && appToken) {
      bot = createBotClient(database, botToken, {
        slackApiUrl,
        onAuthFailed: (error) => slack?.botRejected(error),
        log,
      });
      slack = startSlackSupervisor(database, bot, {
        app: app.name,
        tokens: { botToken, appToken },
        claim,
        slackApiUrl,
        onChange: () => scheduler?.reconsider(),
        onError,
        timings,
        log,
      });
    }
    scheduler = startWakeScheduler(database, (channelId) => wakeLead(origin, channelId, log), {
      acknowledge: (requests) => outbox?.acknowledge(requests),
      onError,
      timings,
      log,
    });
    if (bot) {
      outbox = startOutboxWorker(database, bot, {
        ready: () => slackState().connection === "connected",
        onChange: () => scheduler?.reconsider(),
        onError,
        log,
      });
    }
    const workspaceUrl = () => slack?.workspaceUrl() ?? null;
    const setup = { database, bot, toyBoxOrigin: origin, app: nameApps ? app.name : null };
    return {
      name: app.name,
      database,
      slack: slackState,
      bot,
      workspaceUrl,
      log,
      handlers: {
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
        link: linkCommand(setup),
        allow: allowCommand(setup),
        deny: denyCommand(setup),
        pause: pauseCommand(setup),
        resume: resumeCommand(setup),
        unlink: unlinkCommand(setup),
      },
      onChange: () => scheduler?.reconsider(),
    };
  }

  return {
    name: app.name,
    slackAppId,
    start,
    async stop() {
      clearInterval(retention);
      await scheduler?.stop();
      await outbox?.stop();
      await slack?.stop();
      await database.close();
    },
  };
}
