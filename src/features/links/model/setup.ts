import type { ChannelFacts } from "@slackapi/model/channels";
import type { Installation } from "@slackapi/model/installation";
import { REQUESTS_COMMAND, routineState, type RoutineState } from "@toybox/model";
import type { ToyBoxChannelView } from "@toybox/model/stream";
import {
  allowlistField,
  allowlistUser,
  changedSince,
  checkProposal,
  invalid,
  narrows,
  ownerPresent,
  reapproves,
  settingsPatch,
  type Admitted,
  type Approval,
  type ApprovalAction,
  type ChangedReason,
  type InvalidReason,
  type Json,
  type LinkSettings,
  type LinkStatus,
  type ObserveMode,
  type PatchEntry,
  type PatchField,
  type ProposalDraft,
  type ProposalFacts,
  type ProposalRefusal,
  type ReadSet,
  type RequestMode,
  type SettingsChange,
} from "./approvals";
import { audienceOf, type ApprovedAudience } from "./audience";

// Setup.
//
// A setup command is drafted against its Toy Box channel's link as stored. A set that only narrows
// applies at once. Anything that widens who can make the lead act, or who reads what it says,
// becomes a proposal: the bridge reads the channels, the people and the Toy Box channel it needs
// fresh, checks the change against them, and fixes the read-set its card shows. Once the owner
// approves, apply reads the same facts again for the link as it is then, and the patch goes in
// only while the card's read-set still holds and the change is still valid.

/** One person's allowlist entry. The owner is always allowed and never has one. */
export type AllowlistEntry = { label: string | null };

/** A link as setup reads it. */
export type SetupLink = LinkSettings & {
  id: string;
  status: LinkStatus;
  statusReason: string | null;
  requestsRoutineId: string;
  approved: ApprovedAudience;
  allowlist: ReadonlyMap<string, AllowlistEntry>;
};

/** What setup for a Toy Box channel is decided against. */
export type SetupState = {
  installation: Pick<Installation, "teamId" | "enterpriseId" | "ownerUserId" | "status">;
  toyboxChannelId: string;
  /** The Toy Box channel's link, whatever its status, or null. */
  link: SetupLink | null;
};

/** A setup command that may need the owner's approval. */
export type SetupRequest =
  | {
      action: "link";
      slackChannelId: string;
      routineId: string;
      allow: readonly string[];
      requestMode?: RequestMode;
      observe?: ObserveMode;
      publishChannelId?: string;
    }
  /** Without a label, someone allowed already keeps theirs. */
  | { action: "allow"; userIds: readonly string[]; label?: string }
  | { action: "set"; change: SettingsChange }
  | { action: "resume" }
  | { action: "owner"; userId: string };

/** Why a setup command can't go ahead, whatever Slack and Toy Box say. */
export type SetupRefusal =
  /** Slack rejected the tokens or the app was uninstalled, so nobody could approve. */
  | "not_connected"
  /** Nobody has claimed the bridge, so nobody could approve. */
  | "no_owner"
  | "not_linked"
  | "already_linked"
  /** Only unlink ends a link whose Toy Box channel was deleted. */
  | "toybox_channel_deleted";

export type SetupDraft =
  | { kind: "refused"; reason: SetupRefusal }
  /** Nothing would change: everyone named is allowed already, or each setting has that value. */
  | { kind: "unchanged" }
  /** A set that only narrows, which applies at once. */
  | { kind: "narrowing"; linkId: string; patch: readonly PatchEntry[] }
  /** A change for the owner to approve, with the facts it's checked against. */
  | { kind: "proposal"; proposal: ProposalDraft; needed: FactsNeeded };

/**
 * Drafts a setup command. A new link holds every setting its patch can carry, with requests only
 * when mentioned and text kept only from requesters unless asked otherwise. Allowing the owner, or
 * someone allowed already with the same label, changes nothing.
 */
export function draftSetup(state: SetupState, request: SetupRequest): SetupDraft {
  const { installation, link } = state;
  if (installation.status !== "active") return refused("not_connected");
  const owner = installation.ownerUserId;
  if (owner === null) return refused("no_owner");
  if (request.action === "link") {
    if (link) return refused("already_linked");
    return proposal(state, null, "link", linkPatch(request, owner));
  }
  if (!link) return refused("not_linked");
  switch (request.action) {
    case "allow":
      return proposal(state, link.id, "allow", allowPatch(link, owner, request));
    case "set": {
      const patch = settingsPatch(link, request.change);
      if (patch.length > 0 && patch.every((entry) => narrows(entry, link))) {
        return { kind: "narrowing", linkId: link.id, patch };
      }
      return proposal(state, link.id, "set", patch);
    }
    case "resume":
      if (link.status === "active") return { kind: "unchanged" };
      if (link.status === "suspended" && link.statusReason === "toybox_channel_deleted") {
        return refused("toybox_channel_deleted");
      }
      return proposal(state, link.id, "resume", [{ field: "status", after: "active" }]);
    case "owner": {
      const patch = request.userId === owner ? [] : [ownerEntry(request.userId)];
      return proposal(state, link.id, "owner", patch);
    }
  }
}

/**
 * A patched field's value in `state`. Every field of a link that doesn't exist is null, and so is
 * an allowlist entry that doesn't.
 */
export function valueOf(state: SetupState, field: PatchField): Json {
  const { link } = state;
  switch (field) {
    case "owner_user_id":
      return state.installation.ownerUserId;
    case "slack_channel_id":
      return link?.slackChannelId ?? null;
    case "publish_channel_id":
      return link?.publishChannelId ?? null;
    case "request_mode":
      return link?.requestMode ?? null;
    case "observe":
      return link?.observe ?? null;
    case "requests_routine_id":
      return link?.requestsRoutineId ?? null;
    case "status":
      return link?.status ?? null;
    default: {
      const entry = link?.allowlist.get(allowlistUser(field)!);
      return entry ? { label: entry.label } : null;
    }
  }
}

// Facts.

/** What a change is checked against, named for the link as it is in a state. */
export type FactsNeeded = {
  monitored: string;
  publish: string;
  /** The owner once the change applies, who must be in both channels. */
  owner: string;
  /** Everyone the change allows or makes owner, whom users.info must vouch for. */
  people: readonly string[];
  /** The requests routine the link runs once the change applies. */
  routineId: string;
};

/**
 * The channels, people and routine a change is checked against: what its patch sets, and the
 * link's own settings for anything it doesn't. Null when `state` has no link to read them from.
 */
export function factsNeeded(
  state: SetupState,
  change: Pick<Approval, "patch">,
): FactsNeeded | null {
  const after = (field: PatchField) => change.patch.find((entry) => entry.field === field)?.after;
  const { link } = state;
  const monitored = after("slack_channel_id") ?? link?.slackChannelId;
  const publish = after("publish_channel_id") ?? link?.publishChannelId;
  const owner = after("owner_user_id") ?? state.installation.ownerUserId;
  const routineId = after("requests_routine_id") ?? link?.requestsRoutineId;
  if (
    typeof monitored !== "string" ||
    typeof publish !== "string" ||
    typeof owner !== "string" ||
    typeof routineId !== "string"
  ) {
    return null;
  }
  const people = change.patch.flatMap((entry) => {
    if (entry.field === "owner_user_id")
      return typeof entry.after === "string" ? [entry.after] : [];
    const userId = allowlistUser(entry.field);
    return userId !== null && entry.after !== null ? [userId] : [];
  });
  return { monitored, publish, owner, people: [...new Set(people)], routineId };
}

/** What the bridge read fresh from Slack and Toy Box for the facts a change needs. */
export type FreshFacts = {
  /** conversations.info for each channel, null for a channel Slack can't find. */
  monitored: ChannelFacts | null;
  publish: ChannelFacts | null;
  /** Whether the owner the change leaves in place is in each channel. */
  ownerInMonitored: boolean;
  ownerInPublish: boolean;
  /** users.info for each person the change admits. */
  people: readonly Admitted[];
  /** The Toy Box channel, or null when it's deleted. */
  toyBox: ToyBoxChannelView | null;
};

/**
 * The facts a change is checked against. A channel Slack answered for under another ID counts as
 * one it can't find, so every channel a card shows is the one its patch names.
 */
export function proposalFacts(
  state: SetupState,
  needed: FactsNeeded,
  fresh: FreshFacts,
  linkedElsewhere: boolean,
): ProposalFacts {
  const routine = fresh.toyBox?.routines.find((each) => each.id === needed.routineId) ?? null;
  return {
    home: state.installation,
    monitored: fresh.monitored?.id === needed.monitored ? fresh.monitored : null,
    publish: fresh.publish?.id === needed.publish ? fresh.publish : null,
    approved: state.link?.approved ?? null,
    ownerInMonitored: fresh.ownerInMonitored,
    ownerInPublish: fresh.ownerInPublish,
    provider: fresh.toyBox?.provider ?? null,
    routine: routineState(routine, REQUESTS_COMMAND),
    linkedElsewhere,
    admits: fresh.people,
  };
}

// Proposals.

/** What a proposal is checked against besides the facts read fresh for it. */
export type ProposalContext = {
  /** Every open approval in the installation. */
  open: readonly Approval[];
  /** How many proposals the draft's Toy Box channel made in the past hour. */
  createdInLastHour: number;
  /** Whether another Toy Box channel's link watches the Slack channel the change watches. */
  linkedElsewhere: boolean;
};

/** Why a drafted proposal can't be made. */
export type ProposalPlanRefusal =
  | ProposalRefusal
  /** The owner hasn't posted in the Toy Box channel recently. */
  | "owner_away"
  | InvalidReason;

export type ProposalPlan =
  /** The same change waits already. */
  | { kind: "existing"; approval: Approval }
  | { kind: "refused"; reason: ProposalPlanRefusal }
  /** A new proposal, with the read-set its card shows and the channel the card goes in. */
  | { kind: "new"; readSet: ReadSet; cardChannelId: string };

/**
 * Plans a proposal against open approvals and what was read fresh. The same change pending
 * already is returned, and a draft another open approval overlaps, or past the limits, is
 * refused before the owner's presence is checked, then the change itself. A new proposal's card
 * goes in the Slack channel the link watches, or will watch, and shows both channels as they are
 * now, the owner it asks and each patched field's value before the change.
 */
export function planProposal(
  state: SetupState,
  { proposal: draft, needed }: Extract<SetupDraft, { kind: "proposal" }>,
  fresh: FreshFacts,
  context: ProposalContext,
  now: number,
): ProposalPlan {
  const check = checkProposal(draft, context.open, context.createdInLastHour);
  if (check.kind !== "new") return check;
  if (!fresh.toyBox) return { kind: "refused", reason: "toybox_channel_deleted" };
  if (!ownerPresent(fresh.toyBox.ownerSpokeAt, now))
    return { kind: "refused", reason: "owner_away" };
  const facts = proposalFacts(state, needed, fresh, context.linkedElsewhere);
  const reason = invalid(draft, facts);
  if (reason) return { kind: "refused", reason };
  // A drafted proposal has an owner to ask, and invalid found both channels, so each has an audience.
  const readSet: ReadSet = {
    ownerUserId: state.installation.ownerUserId!,
    link: readSetLink(state),
    monitored: audienceOf(facts.monitored!, facts.home)!,
    publish: audienceOf(facts.publish!, facts.home)!,
    before: valuesOf(state, draft.patch),
  };
  return { kind: "new", readSet, cardChannelId: readSet.monitored.channelId };
}

// Apply.

export type ApplyVerdict =
  /** Something the card showed changed, or the change is no longer valid. */
  | { kind: "stale"; reason: ChangedReason | InvalidReason }
  /**
   * The patch goes in. `approved` is each channel's audience as the owner has approved it once it
   * does, which for a change that approves them anew is what its card showed, and `routine` is the
   * state of the requests routine the link runs.
   */
  | { kind: "apply"; approved: ApprovedAudience; routine: RoutineState };

/**
 * Judges an approved change against `state` and what was read fresh for it. The read-set must
 * still hold and the change must still be valid, exactly as when it was proposed but for the
 * owner's presence. A change that approves either channel's audience anew, which a link, a resume
 * and a move of the publish channel do, keeps both audiences as they are now. Any other keeps
 * what the owner approved before.
 */
export function judgeApply(
  state: SetupState,
  approval: Approval,
  fresh: FreshFacts,
  linkedElsewhere: boolean,
): ApplyVerdict {
  const needed = factsNeeded(state, approval);
  const facts = needed && proposalFacts(state, needed, fresh, linkedElsewhere);
  const changed = changedSince(approval.readSet, {
    home: state.installation,
    ownerUserId: state.installation.ownerUserId,
    link: readSetLink(state),
    monitored: facts?.monitored ?? null,
    publish: facts?.publish ?? null,
    values: valuesOf(state, approval.patch),
  });
  if (changed) return { kind: "stale", reason: changed };
  // Both channels the card showed were found as it showed them, so the change named its facts.
  const checked = facts!;
  const reason = invalid(approval, checked);
  if (reason) return { kind: "stale", reason };
  const { monitored, publish } = approval.readSet;
  const anew = reapproves(approval);
  // A change that approves neither audience anew has a link, which the read-set showed.
  const approved = anew.monitored || anew.publish ? { monitored, publish } : state.link!.approved;
  return { kind: "apply", approved, routine: checked.routine };
}

function linkPatch(
  request: Extract<SetupRequest, { action: "link" }>,
  owner: string,
): PatchEntry[] {
  const allowed = [...new Set(request.allow)].filter((userId) => userId !== owner);
  return [
    { field: "slack_channel_id", after: request.slackChannelId },
    { field: "publish_channel_id", after: request.publishChannelId ?? request.slackChannelId },
    { field: "request_mode", after: request.requestMode ?? "mention" },
    { field: "observe", after: request.observe ?? "requesters" },
    { field: "requests_routine_id", after: request.routineId },
    ...allowed.map((userId) => ({ field: allowlistField(userId), after: { label: null } })),
  ];
}

function allowPatch(
  link: SetupLink,
  owner: string,
  request: Extract<SetupRequest, { action: "allow" }>,
): PatchEntry[] {
  const patch: PatchEntry[] = [];
  for (const userId of new Set(request.userIds)) {
    if (userId === owner) continue;
    const entry = link.allowlist.get(userId);
    const label = request.label ?? entry?.label ?? null;
    if (entry?.label === label) continue;
    patch.push({ field: allowlistField(userId), after: { label } });
  }
  return patch;
}

function ownerEntry(userId: string): PatchEntry {
  return { field: "owner_user_id", after: userId };
}

function proposal(
  state: SetupState,
  linkId: string | null,
  action: ApprovalAction,
  patch: readonly PatchEntry[],
): SetupDraft {
  if (patch.length === 0) return { kind: "unchanged" };
  // Only a state with an owner, and a link unless this is one, drafts a proposal.
  const needed = factsNeeded(state, { patch })!;
  return {
    kind: "proposal",
    proposal: { toyboxChannelId: state.toyboxChannelId, linkId, action, patch },
    needed,
  };
}

function valuesOf(state: SetupState, patch: readonly PatchEntry[]): ReadSet["before"] {
  return Object.fromEntries(patch.map((entry) => [entry.field, valueOf(state, entry.field)]));
}

function readSetLink({ link }: SetupState): ReadSet["link"] {
  return link ? { id: link.id, status: link.status, statusReason: link.statusReason } : "none";
}

function refused(reason: SetupRefusal): SetupDraft {
  return { kind: "refused", reason };
}
