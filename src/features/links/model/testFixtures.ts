import type { Audience } from "./audience";

/** A private channel in the installation's workspace, shared with no one. */
export function privateAudience(): Audience {
  return {
    kind: "private",
    external: false,
    orgShared: false,
    enterpriseId: null,
    workspaces: ["T-home"],
  };
}
