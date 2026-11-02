import { onTestFinished, spyOn } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";
import type { InstallationStatus } from "@slackapi/model/installation";

/** What Slack's SDKs printed, which goes to the console rather than through `log`. */
export function captureConsole(): () => unknown[][] {
  const spies = (["debug", "info", "warn", "error"] as const).map((level) => {
    const spy = spyOn(console, level).mockImplementation(() => {});
    onTestFinished(() => spy.mockRestore());
    return spy;
  });
  return () => spies.flatMap((spy) => spy.mock.calls);
}

/**
 * Answers the bridge can't read, by what's wrong with them, for Fake Slack to give in place of a
 * method's own. Every schema the bridge reads an answer with fails a bare ok, and the Slack SDK
 * fails on the rest before any schema runs.
 */
export const unreadableAnswers = [
  ["fails its schema", JSON.stringify({ ok: true })],
  ["is JSON null", "null"],
  ["is a bare string", JSON.stringify("ok")],
  ["has a null response_metadata", JSON.stringify({ ok: true, response_metadata: null })],
] as const;

/** Non-JSON answers the SDK otherwise treats as Slack error codes, using the whole body. */
export const nonJsonAnswers = [
  ["names a rate limit without JSON", "ratelimited"],
  ["names a refusal without JSON", "invalid_blocks"],
  ["is HTML", "<html>The staging password is hunter2</html>"],
  ["is empty", ""],
  ["is unfinished JSON", '{"ok":'],
] as const;

/**
 * Persist the installation the other fixtures belong to: app A-app in team T-home, with our bot
 * U-bot. `columns` replace the fixture's, such as an uninstalled status.
 */
export function createStoredInstallation(
  database: BridgeDatabase,
  columns: {
    bot_user_id?: string;
    status?: InstallationStatus;
  } = {},
) {
  const installation = {
    id: 1,
    team_id: "T-home",
    app_id: "A-app",
    bot_id: "B-bot",
    bot_user_id: "U-bot",
    status: "active",
    ...columns,
  };
  return database.write(
    (transaction) => transaction`INSERT INTO installation ${transaction(installation)}`,
  );
}
