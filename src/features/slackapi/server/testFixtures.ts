import { onTestFinished, spyOn } from "bun:test";
import type { BridgeDatabase } from "@bridge/server/database";

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
 * Persist the installation the other fixtures belong to: app A-app in team T-home, with our bot
 * U-bot. `columns` replace the fixture's, such as an uninstalled status.
 */
export function createStoredInstallation(
  database: BridgeDatabase,
  columns: {
    bot_user_id?: string;
    status?: "active" | "auth_failed" | "uninstalled";
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
