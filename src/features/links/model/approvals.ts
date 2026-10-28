// Approvals.
//
// A setup change that widens who can make the lead act, or who reads what it says, waits for the
// pinned owner's click on a card the bridge posts in Slack. A proposal fixes what its card shows
// when it's made: the patch it applies and the read-set it's decided against. A click is decided
// from stored facts before Slack is acked, and the patch applies after, only while fresh facts
// still match the read-set. A narrowing change applies at once and voids the cards it reverses,
// so a value that changes and changes back before the click can't carry an old card through.

import type { ChannelFacts } from "@slackapi/model/channels";
import type { Installation } from "@slackapi/model/installation";
import type { BlockActions } from "@slackapi/model/interactions";
import type { SlackTs } from "@slackapi/model/ts";
import type { SlackPerson } from "@slackapi/model/users";
import type { RoutineState } from "@toybox/model";
import { admissionProblem, type AdmissionProblem } from "./admission";
import {
  audienceOf,
  audienceProblem,
  widening,
  type ApprovedAudience,
  type Audience,
  type AudienceProblem,
  type Widening,
} from "./audience";

/** What a proposal asks for. `set` widens a link's settings, and `owner` hands ownership on. */
export type ApprovalAction = "link" | "allow" | "set" | "resume" | "owner";

export const approvalStates = [
  "pending",
  "approved",
  "applied",
  "rejected",
  "expired",
  "stale",
] as const;

export type ApprovalState = (typeof approvalStates)[number];

export type LinkStatus = "active" | "paused" | "suspended";

/** The link columns a proposal can change. */
export type LinkField =
  | "slack_channel_id"
  | "publish_channel_id"
  | "request_mode"
  | "observe"
  | "requests_routine_id"
  | "status";

/** One person's allowlist entry. */
export type AllowlistField = `allowlist.${string}`;

/** What a patch changes, named by column: a link's, the installation's owner, or an allowlist entry. */
export type PatchField = LinkField | "owner_user_id" | AllowlistField;

export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

export type PatchEntry = { field: PatchField; after: Json };

export type ReadSetLink = { id: string; status: LinkStatus; statusReason: string | null };

/** Everything a card shows besides its patch, as it was when the proposal was made. */
export type ReadSet = {
  ownerUserId: string;
  link: ReadSetLink | "none";
  monitored: Audience;
  publish: Audience;
  /** Each patched field's value when the proposal was made. An absent allowlist entry is null. */
  before: Partial<Record<PatchField, Json>>;
};

/** Why an approval went stale. */
export type StaleReason =
  | ChangedReason
  | InvalidReason
  /** A narrowing change reversed it: deny, pause, unlink or a set. */
  | "reversed"
  /** Apply couldn't fetch fresh facts in time. */
  | "not_verified";

/** What the card showed that's no longer true. */
export type ChangedReason =
  /** The pinned owner isn't the one the card asked. */
  | "owner_changed"
  /** The link appeared or went away, or its status or the reason for it changed. */
  | "link_changed"
  /** A channel isn't the one the card showed, or its kind or sharing changed. */
  | "audience_changed"
  /** A patched field no longer holds the value the card showed. */
  | "setting_changed";

/** Why a change can't apply, whether it's proposed now or was approved earlier. */
export type InvalidReason =
  | "channel_not_found"
  /** A direct message, which a link can't use. */
  | "not_a_channel"
  | "channel_archived"
  | "bot_not_member"
  | AudienceProblem
  /** A channel the change doesn't approve anew is wider than when the owner last approved it. */
  | Widening
  | "owner_not_member"
  /** Toy Box has no such channel. */
  | "toybox_channel_deleted"
  /** The lead doesn't run on Copilot. */
  | "provider"
  | "routine_missing"
  /** Another link watches the Slack channel, or the Toy Box channel is linked already. */
  | "already_linked"
  /** The person an allow or owner change names can't be admitted. */
  | AdmissionProblem
  /** Someone is named by an ID other than the one users.info gives them, which an allowlist holds. */
  | "other_id";

/** Who asked for a change. */
export type ProposalCaller = "lead" | "operator";

export type Approval = {
  /** 128 random bits, the only value a button carries. */
  id: string;
  /** Shown as a4. */
  number: number;
  toyboxChannelId: string;
  /** Null for a new link. */
  linkId: string | null;
  action: ApprovalAction;
  /** Only the fields this approval changes. */
  patch: readonly PatchEntry[];
  readSet: ReadSet;
  card: { channelId: string; ts: SlackTs | null };
  state: ApprovalState;
  staleReason: StaleReason | null;
  appliedAt: number | null;
  /** Set together once the owner clicks. A timer's expiry and a voiding leave them unset. */
  decidedBy: string | null;
  decidedAt: number | null;
  /** When inbox showed the lead the outcome. */
  reportedAt: number | null;
  createdBy: ProposalCaller;
  createdAt: number;
  expiresAt: number;
};

/** How long a card waits for the owner. */
export const APPROVAL_LIFETIME_MS = 60 * 60_000;

/** How long apply keeps trying to fetch fresh facts before the approval goes stale. */
export const APPLY_VERIFY_MS = 15 * 60_000;

/** The most proposals a Toy Box channel may have pending at once. */
export const MAX_PENDING = 3;

/** The most proposals a Toy Box channel may make in an hour. */
export const MAX_CREATED_PER_HOUR = 10;

/** The most people one proposal may allow, so the owner reads every name on one card. */
export const MAX_ALLOWED_PER_PROPOSAL = 20;

/** Widening is refused unless the owner posted in the Toy Box channel this recently. */
export const OWNER_PRESENCE_MS = 30 * 60_000;

export const APPROVE_ACTION_ID = "approval.approve";
export const REJECT_ACTION_ID = "approval.reject";

const transitions: Record<ApprovalState, readonly ApprovalState[]> = {
  pending: ["approved", "rejected", "expired", "stale"],
  approved: ["applied", "stale"],
  applied: [],
  rejected: [],
  expired: [],
  stale: [],
};

/** Thrown when an approval's state doesn't allow a change. */
export class ApprovalStateError extends Error {
  constructor(
    readonly state: ApprovalState,
    readonly change: ApprovalState,
  ) {
    super(`An approval that's ${state} can't become ${change}.`);
  }
}

/** Whether an approval may still change: it waits for the owner, or for apply. */
export function isOpen(state: ApprovalState): boolean {
  return transitions[state].length > 0;
}

/** Whether an approval may move from one state to another. */
export function canMove(from: ApprovalState, to: ApprovalState): boolean {
  return transitions[from].includes(to);
}

/** The field of `userId`'s allowlist entry. */
export function allowlistField(userId: string): AllowlistField {
  return `allowlist.${userId}`;
}

/** The person whose allowlist entry `field` is, or null for any other field. */
export function allowlistUser(field: PatchField): string | null {
  return field.startsWith("allowlist.") ? field.slice("allowlist.".length) : null;
}

/** Whether `approval`'s patch changes `field`. */
export function touches(approval: Pick<Approval, "patch">, field: PatchField): boolean {
  return approval.patch.some((entry) => entry.field === field);
}

// A click.

/** A click on a card's button, with who clicked mapped to the person their ID is an alias for. */
export type ApprovalClick = BlockActions;

/** The installation a click is checked against, read in the click's transaction. */
export type ClickInstallation = Pick<Installation, "appId" | "teamId" | "ownerUserId" | "status">;

export type IgnoredClick =
  | "wrong_app"
  /** Slack rejected the tokens, so nothing is decided until the bridge has rechecked who it is. */
  | "not_connected"
  | "unknown_action"
  | "unknown_card"
  | "not_owner";

/** What the owner's click makes of a pending approval: their decision, or expired when it came too late. */
export type ClickedState = "approved" | "rejected" | "expired";

export type ClickDecision =
  | { kind: "ignored"; reason: IgnoredClick }
  /** The owner's click on an approval decided already, so a repeated or redelivered click does nothing. */
  | { kind: "unchanged" }
  /** The approval as the click settles it. */
  | { kind: "settled"; approval: Approval & { state: ClickedState } };

/** The approval ID a click names, which the receiver looks up before deciding. */
export function clickedApprovalId(click: ApprovalClick): string | null {
  return click.actions.length === 1 ? click.actions[0]!.value : null;
}

/**
 * Decides a click from stored facts alone, before Slack is acked. Only the pinned owner, who is
 * also the owner the card asked, can decide, and only a pending card on its own message. A
 * stranger's click changes nothing, so the card stays pending, and it's a stranger's click whatever
 * state the card is in. With no installation, no click is the app's, and while the installation
 * isn't active, no click is decided.
 */
export function decide(
  click: ApprovalClick,
  installation: ClickInstallation | null,
  approval: Approval | null,
  now: number,
): ClickDecision {
  if (!installation || click.appId !== installation.appId || click.teamId !== installation.teamId) {
    return ignored("wrong_app");
  }
  if (installation.status !== "active") return ignored("not_connected");
  if (click.actions.length !== 1) return ignored("unknown_action");
  const [action] = click.actions;
  if (action!.actionId !== APPROVE_ACTION_ID && action!.actionId !== REJECT_ACTION_ID) {
    return ignored("unknown_action");
  }
  if (
    !approval ||
    approval.id !== action!.value ||
    approval.card.ts === null ||
    approval.card.channelId !== click.message?.channelId ||
    approval.card.ts !== click.message.ts
  ) {
    return ignored("unknown_card");
  }
  if (
    installation.ownerUserId === null ||
    click.userId !== installation.ownerUserId ||
    click.userId !== approval.readSet.ownerUserId
  ) {
    return ignored("not_owner");
  }
  if (approval.state !== "pending") return { kind: "unchanged" };
  if (now >= approval.expiresAt) {
    return { kind: "settled", approval: expireApproval(approval, now, click.userId) };
  }
  const state = action!.actionId === APPROVE_ACTION_ID ? "approved" : "rejected";
  return {
    kind: "settled",
    approval: move(approval, state, { decidedBy: click.userId, decidedAt: now }),
  };
}

/**
 * Expires a pending approval. A click that came too late records who made it, so the lead hears
 * the outcome. The timer leaves the decision unset.
 */
export function expireApproval(
  approval: Approval,
  now: number,
  decidedBy: string | null = null,
): Approval & { state: "expired" } {
  if (now < approval.expiresAt) {
    throw new RangeError(`Approval ${approval.id} expires at ${approval.expiresAt}, not ${now}`);
  }
  const decided = decidedBy === null ? {} : { decidedBy, decidedAt: now };
  return move(approval, "expired", decided);
}

/** Marks a pending or approved approval stale. Whatever the owner decided stays recorded. */
export function staleApproval(approval: Approval, reason: StaleReason): Approval {
  return move(approval, "stale", { staleReason: reason });
}

/** Marks an approved approval applied, once its patch is in. */
export function applyApproval(approval: Approval, now: number): Approval {
  return move(approval, "applied", { appliedAt: now });
}

// Apply.

/** What's true now of everything a read-set holds. */
export type CurrentFacts = {
  home: Pick<Installation, "teamId">;
  ownerUserId: string | null;
  link: ReadSetLink | "none";
  /** Fresh conversations.info for the read-set's channels, null for a channel Slack can't find. */
  monitored: ChannelFacts | null;
  publish: ChannelFacts | null;
  /** The patched fields' values now. An absent allowlist entry is null. */
  values: Partial<Record<PatchField, Json>>;
};

/**
 * Why the read-set no longer holds, or null. Only what the card showed counts: the owner, the
 * link with its status and reason, both channels' audience, and each patched field's before
 * value. A change to anything else, such as another person's allowlist entry, doesn't matter.
 */
export function changedSince(readSet: ReadSet, current: CurrentFacts): ChangedReason | null {
  if (current.ownerUserId !== readSet.ownerUserId) return "owner_changed";
  if (!Bun.deepEquals(current.link, readSet.link, true)) return "link_changed";
  const audience = (facts: ChannelFacts | null) => facts && audienceOf(facts, current.home);
  if (
    !Bun.deepEquals(audience(current.monitored), readSet.monitored, true) ||
    !Bun.deepEquals(audience(current.publish), readSet.publish, true)
  ) {
    return "audience_changed";
  }
  for (const [field, before] of Object.entries(readSet.before)) {
    if (!Bun.deepEquals(current.values[field as PatchField] ?? null, before, true)) {
      return "setting_changed";
    }
  }
  return null;
}

/** The facts a change is checked against when it's proposed and again when it applies. */
export type ProposalFacts = {
  /** The installation's workspace and org, which the channels and anyone admitted must be in. */
  home: Pick<Installation, "teamId" | "enterpriseId">;
  /** conversations.info for each channel, null for a channel Slack can't find. */
  monitored: ChannelFacts | null;
  publish: ChannelFacts | null;
  /** The audiences the owner last approved for the link, or null for a new link. */
  approved: ApprovedAudience | null;
  /** Whether the owner the change leaves in place is in each channel. */
  ownerInMonitored: boolean;
  ownerInPublish: boolean;
  /** The lead's provider, or null when Toy Box has no such channel. */
  provider: string | null;
  /** The requests routine the link runs, as Toy Box shows it now. */
  routine: RoutineState;
  /** Whether another link watches the Slack channel, or the Toy Box channel has another link. */
  linkedElsewhere: boolean;
  /** Everyone an allow, link or owner change admits, as users.info says now. */
  admits: readonly Admitted[];
};

/** Someone a change admits, with users.info for them, or null when Slack doesn't know them. */
export type Admitted = { userId: string; person: SlackPerson | null };

/** Which of a link's channels a change asks the owner to approve the audience of anew. */
export function reapproves(draft: Pick<Approval, "action" | "patch">): {
  monitored: boolean;
  publish: boolean;
} {
  if (draft.action === "link" || draft.action === "resume") {
    return { monitored: true, publish: true };
  }
  return { monitored: false, publish: touches(draft, "publish_channel_id") };
}

/**
 * Why a change can't apply, or null. Each channel must be a public or private channel,
 * unarchived, with the bot in it, inside the installation's workspace or org and shared with no
 * other organization. A channel whose audience the change doesn't approve anew must be no wider
 * than the owner last approved, so no change can carry a widening through. The owner must be in
 * both channels, the Toy Box channel must still be there with its lead on Copilot, the requests
 * routine must exist, no other link may watch the channel it watches, and anyone the change admits
 * must pass the admission check under the ID Slack gives them.
 */
export function invalid(
  draft: Pick<Approval, "action" | "patch">,
  facts: ProposalFacts,
): InvalidReason | null {
  const fresh = reapproves(draft);
  const channels = [
    { facts: facts.monitored, approved: fresh.monitored ? null : facts.approved?.monitored },
    { facts: facts.publish, approved: fresh.publish ? null : facts.approved?.publish },
  ];
  for (const channel of channels) {
    if (!channel.facts) return "channel_not_found";
    const audience = audienceOf(channel.facts, facts.home);
    if (!audience) return "not_a_channel";
    if (channel.facts.isArchived) return "channel_archived";
    if (!channel.facts.isMember) return "bot_not_member";
    const problem = audienceProblem(audience, facts.home);
    if (problem) return problem;
    const wider = channel.approved && widening(channel.approved, audience);
    if (wider) return wider;
  }
  if (!facts.ownerInMonitored || !facts.ownerInPublish) return "owner_not_member";
  if (facts.provider === null) return "toybox_channel_deleted";
  if (facts.provider !== "copilot") return "provider";
  if (facts.routine === "missing") return "routine_missing";
  if (facts.linkedElsewhere) return "already_linked";
  for (const { userId, person } of facts.admits) {
    const problem = admissionProblem(userId, person, facts.home);
    if (problem) return problem;
    // Each of someone's IDs maps to the one users.info gives them, so only that one ever matches.
    if (userId !== person!.id) return "other_id";
  }
  return null;
}

// Narrowing.

/** A change that applied at once and voids whatever approvals it reverses. */
export type Narrowing =
  | { kind: "deny"; linkId: string; userId: string }
  | { kind: "pause"; linkId: string }
  | { kind: "unlink"; linkId: string }
  | { kind: "set"; linkId: string; fields: readonly LinkField[] };

/**
 * Whether `narrowing` reverses an open approval: deny U voids allowing U, pause voids resume,
 * unlink voids every card for the link, and a narrowing set voids any card that changes one of
 * its fields.
 */
export function reverses(narrowing: Narrowing, approval: Approval): boolean {
  if (!isOpen(approval.state)) return false;
  if (approval.linkId !== narrowing.linkId) return false;
  switch (narrowing.kind) {
    case "unlink":
      return true;
    case "pause":
      return touches(approval, "status");
    case "deny":
      return touches(approval, allowlistField(narrowing.userId));
    case "set":
      return narrowing.fields.some((field) => touches(approval, field));
  }
}

// Settings.

export type RequestMode = "mention" | "all";
export type ObserveMode = "requesters" | "channel";

/** A link's settings that `set` changes. */
export type LinkSettings = {
  slackChannelId: string;
  publishChannelId: string;
  requestMode: RequestMode;
  observe: ObserveMode;
};

export type SettingsChange = {
  requestMode?: RequestMode;
  observe?: ObserveMode;
  publishChannelId?: string;
};

/** The fields a change actually changes, with their values after it. */
export function settingsPatch(current: LinkSettings, change: SettingsChange): PatchEntry[] {
  const patch: PatchEntry[] = [];
  if (change.requestMode !== undefined && change.requestMode !== current.requestMode) {
    patch.push({ field: "request_mode", after: change.requestMode });
  }
  if (change.observe !== undefined && change.observe !== current.observe) {
    patch.push({ field: "observe", after: change.observe });
  }
  if (
    change.publishChannelId !== undefined &&
    change.publishChannelId !== current.publishChannelId
  ) {
    patch.push({ field: "publish_channel_id", after: change.publishChannelId });
  }
  return patch;
}

/**
 * Whether an entry of a settings patch narrows the link: answering only mentions, keeping only
 * requesters' text, or publishing back to the watched channel, whose audience the owner approved
 * when the link was made. Anything else widens.
 */
export function narrows(entry: PatchEntry, current: LinkSettings): boolean {
  switch (entry.field) {
    case "request_mode":
      return entry.after === "mention";
    case "observe":
      return entry.after === "requesters";
    case "publish_channel_id":
      return entry.after === current.slackChannelId;
    default:
      return false;
  }
}

// Proposals.

/** A change the bridge would ask the owner to approve. */
export type ProposalDraft = {
  toyboxChannelId: string;
  linkId: string | null;
  action: ApprovalAction;
  patch: readonly PatchEntry[];
};

export type ProposalRefusal =
  /** It allows more people than one card shows. */
  | "too_many_people"
  /** Another open approval changes one of the same fields, or links the same Slack channel. */
  | "overlap"
  | "too_many_pending"
  | "too_many_created";

export type ProposalCheck =
  | { kind: "new" }
  /** The same change is waiting already, so proposing it again returns that approval. */
  | { kind: "existing"; approval: Approval }
  | { kind: "refused"; reason: ProposalRefusal };

/**
 * Checks a draft against every open approval, whichever Toy Box channel proposed it, and against
 * how many its own Toy Box channel created in the past hour. A link's fields belong to its Toy Box
 * channel, so only that channel's approvals change the same ones. The owner is the installation's,
 * so any approval that hands it on overlaps another, and so does any that links the same Slack
 * channel, which no two links can watch. The limits count the draft's Toy Box channel alone.
 */
export function checkProposal(
  draft: ProposalDraft,
  open: readonly Approval[],
  createdInLastHour: number,
): ProposalCheck {
  const people = draft.patch.filter((entry) => allowlistUser(entry.field) !== null).length;
  if (people > MAX_ALLOWED_PER_PROPOSAL) return { kind: "refused", reason: "too_many_people" };
  const own = open.filter((approval) => approval.toyboxChannelId === draft.toyboxChannelId);
  const same = own.find(
    (approval) =>
      approval.action === draft.action &&
      approval.linkId === draft.linkId &&
      samePatch(approval.patch, draft.patch),
  );
  if (same) return { kind: "existing", approval: same };
  if (open.some((approval) => overlaps(approval, draft))) {
    return { kind: "refused", reason: "overlap" };
  }
  if (own.filter((approval) => approval.state === "pending").length >= MAX_PENDING) {
    return { kind: "refused", reason: "too_many_pending" };
  }
  if (createdInLastHour >= MAX_CREATED_PER_HOUR) {
    return { kind: "refused", reason: "too_many_created" };
  }
  return { kind: "new" };
}

function overlaps(approval: Approval, draft: ProposalDraft): boolean {
  return draft.patch.some((entry) => {
    const theirs = approval.patch.find((other) => other.field === entry.field);
    if (!theirs) return false;
    if (entry.field === "owner_user_id") return true;
    if (approval.toyboxChannelId === draft.toyboxChannelId) return true;
    return entry.field === "slack_channel_id" && theirs.after === entry.after;
  });
}

/** Whether the owner posted in the Toy Box channel recently enough for widening setup to run. */
export function ownerPresent(ownerSpokeAt: number | null, now: number): boolean {
  return ownerSpokeAt !== null && now - ownerSpokeAt <= OWNER_PRESENCE_MS;
}

function samePatch(left: readonly PatchEntry[], right: readonly PatchEntry[]): boolean {
  const sorted = (patch: readonly PatchEntry[]) =>
    patch.toSorted((a, b) => a.field.localeCompare(b.field));
  return Bun.deepEquals(sorted(left), sorted(right), true);
}

function move<To extends ApprovalState>(
  approval: Approval,
  to: To,
  changes: Partial<Approval>,
): Approval & { state: To } {
  if (!canMove(approval.state, to)) throw new ApprovalStateError(approval.state, to);
  return { ...approval, ...changes, state: to };
}

function ignored(reason: IgnoredClick): ClickDecision {
  return { kind: "ignored", reason };
}
