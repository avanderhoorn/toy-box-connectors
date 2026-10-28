// The installation.
//
// The bridge belongs to one app installed in one workspace, and only that installation's events
// and people count. Startup records it once Slack confirms the tokens' identity.

/** Active until Slack rejects the tokens, or the app is uninstalled or its bot token revoked. */
export type InstallationStatus = "active" | "auth_failed" | "uninstalled";

/** The workspace, app and bot user the bridge belongs to. */
export type Installation = {
  teamId: string;
  appId: string;
  botId: string;
  botUserId: string;
  /** The Enterprise org the workspace belongs to, or null for a standalone workspace. */
  enterpriseId: string | null;
  status: InstallationStatus;
};
