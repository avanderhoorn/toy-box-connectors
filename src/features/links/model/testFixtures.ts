import { APPROVAL_LIFETIME_MS, type Approval } from "./approvals";
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

/**
 * A pending proposal to allow U-carol on `link`, asked of U-owner, whose card is posted in C-link
 * at 1000.000100. `changes` replace its fields.
 */
export function pendingApproval<Changes extends Partial<Approval> = {}>(
  changes: Changes = {} as Changes,
): Approval & Changes {
  return {
    id: "approval-1",
    number: 1,
    toyboxChannelId: "toybox-link",
    linkId: "link",
    action: "allow",
    patch: [{ field: "allowlist.U-carol", after: { label: null } }],
    readSet: {
      ownerUserId: "U-owner",
      link: { id: "link", status: "active", statusReason: null },
      monitored: privateAudience(),
      publish: privateAudience(),
      before: { "allowlist.U-carol": null },
    },
    card: { channelId: "C-link", ts: "1000.000100" },
    state: "pending",
    staleReason: null,
    appliedAt: null,
    decidedBy: null,
    decidedAt: null,
    reportedAt: null,
    createdBy: "lead",
    createdAt: 0,
    expiresAt: APPROVAL_LIFETIME_MS,
    ...changes,
  };
}
