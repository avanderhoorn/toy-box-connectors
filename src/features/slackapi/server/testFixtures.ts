import type { BridgeDatabase } from "@bridge/server/database";

/**
 * Persist the installation the other fixtures belong to: app A-app in team T-home, with our bot
 * U-bot, owned by U-owner. `columns` replace the fixture's, such as a null owner before a claim.
 */
export function createStoredInstallation(
  database: BridgeDatabase,
  columns: {
    bot_user_id?: string;
    enterprise_id?: string | null;
    owner_user_id?: string | null;
    status?: "active" | "auth_failed" | "uninstalled";
  } = {},
) {
  const installation = {
    id: 1,
    team_id: "T-home",
    app_id: "A-app",
    bot_id: "B-bot",
    bot_user_id: "U-bot",
    owner_user_id: "U-owner",
    status: "active",
    ...columns,
  };
  return database.write(
    (transaction) => transaction`INSERT INTO installation ${transaction(installation)}`,
  );
}
