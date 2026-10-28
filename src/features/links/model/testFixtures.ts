import type { Audience } from "./audience";

/** A private channel in the installation's workspace, shared with no one: C-link unless `channelId` says. */
export function privateAudience(channelId = "C-link"): Audience {
  return {
    channelId,
    kind: "private",
    external: false,
    orgShared: false,
    enterpriseId: null,
    workspaces: ["T-home"],
  };
}
