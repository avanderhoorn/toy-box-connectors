import { describe, expect, test } from "bun:test";
import { channelFacts, slackPerson } from "@slackapi/model/testFixtures";
import {
  allowlistField,
  allowlistUser,
  APPROVAL_LIFETIME_MS,
  applyApproval,
  ApprovalStateError,
  approvalStates,
  APPROVE_ACTION_ID,
  canMove,
  changedSince,
  checkProposal,
  clickedApprovalId,
  decide,
  expireApproval,
  invalid,
  isOpen,
  narrows,
  ownerPresent,
  REJECT_ACTION_ID,
  reverses,
  settingsPatch,
  staleApproval,
  type ApprovalClick,
  type ClickInstallation,
  type CurrentFacts,
  type LinkSettings,
  type ProposalFacts,
} from "./approvals";
import { pendingApproval, privateAudience } from "./testFixtures";

describe("approval states", () => {
  test("pending waits for the owner and approved waits for apply, and nothing else moves", () => {
    expect(approvalStates.filter(isOpen)).toEqual(["pending", "approved"]);
    expect(canMove("pending", "approved")).toBe(true);
    expect(canMove("approved", "applied")).toBe(true);
    expect(canMove("approved", "rejected")).toBe(false);
    expect(canMove("pending", "applied")).toBe(false);
    for (const state of ["applied", "rejected", "expired", "stale"] as const) {
      for (const next of approvalStates) expect(canMove(state, next)).toBe(false);
    }
  });

  test("an open approval can go stale with a reason, and keeps whatever the owner decided", () => {
    expect(staleApproval(pendingApproval(), "reversed")).toEqual(
      pendingApproval({ state: "stale", staleReason: "reversed" }),
    );
    const approved = pendingApproval({ state: "approved", decidedBy: "U-owner", decidedAt: 5 });
    expect(staleApproval(approved, "audience_changed")).toEqual({
      ...approved,
      state: "stale",
      staleReason: "audience_changed",
    });
  });

  test("only an approved approval applies", () => {
    const approved = pendingApproval({ state: "approved", decidedBy: "U-owner", decidedAt: 5 });
    expect(applyApproval(approved, 9)).toEqual({ ...approved, state: "applied", appliedAt: 9 });
    expect(() => applyApproval(pendingApproval(), 9)).toThrow(ApprovalStateError);
  });

  test("a closed approval can't change again", () => {
    const applied = pendingApproval({
      state: "applied",
      decidedBy: "U-owner",
      decidedAt: 5,
      appliedAt: 9,
    });
    expect(() => staleApproval(applied, "reversed")).toThrow(
      "An approval that's applied can't become stale.",
    );
  });

  test("the timer expires a pending approval without deciding it", () => {
    expect(expireApproval(pendingApproval(), APPROVAL_LIFETIME_MS)).toEqual(
      pendingApproval({ state: "expired" }),
    );
    expect(() => expireApproval(pendingApproval(), APPROVAL_LIFETIME_MS - 1)).toThrow(RangeError);
  });
});

describe("deciding a click", () => {
  const installation: ClickInstallation = {
    appId: "A-app",
    teamId: "T-home",
    ownerUserId: "U-owner",
    status: "active",
  };
  const click: ApprovalClick = {
    appId: "A-app",
    teamId: "T-home",
    userId: "U-owner",
    actions: [{ actionId: APPROVE_ACTION_ID, value: "approval-1" }],
    message: { channelId: "C-link", ts: "1000.000100" },
  };
  const at = 60_000;

  test("the owner's Approve approves the card, recording who decided and when", () => {
    expect(decide(click, installation, pendingApproval(), at)).toEqual({
      kind: "settled",
      approval: pendingApproval({ state: "approved", decidedBy: "U-owner", decidedAt: at }),
    });
  });

  test("the owner's Reject rejects it", () => {
    const reject = { ...click, actions: [{ actionId: REJECT_ACTION_ID, value: "approval-1" }] };
    expect(decide(reject, installation, pendingApproval(), at)).toEqual({
      kind: "settled",
      approval: pendingApproval({ state: "rejected", decidedBy: "U-owner", decidedAt: at }),
    });
  });

  test("a click names its approval only through its one action's value", () => {
    expect(clickedApprovalId(click)).toBe("approval-1");
    expect(clickedApprovalId({ ...click, actions: [] })).toBeNull();
    expect(clickedApprovalId({ ...click, actions: [...click.actions, ...click.actions] })).toBe(
      null,
    );
  });

  test("a click for another app or team, or for an org-wide install, is ignored", () => {
    for (const other of [{ appId: "A-other" }, { teamId: "T-other" }, { teamId: null }]) {
      expect(decide({ ...click, ...other }, installation, pendingApproval(), at)).toEqual({
        kind: "ignored",
        reason: "wrong_app",
      });
    }
  });

  test("with no installation, no click is the app's", () => {
    expect(decide(click, null, pendingApproval(), at)).toEqual({
      kind: "ignored",
      reason: "wrong_app",
    });
  });

  test("while Slack rejects the tokens or the app is gone, no click is decided", () => {
    for (const status of ["auth_failed", "uninstalled"] as const) {
      expect(decide(click, { ...installation, status }, pendingApproval(), at)).toEqual({
        kind: "ignored",
        reason: "not_connected",
      });
    }
  });

  test("anything but exactly one Approve or Reject is an unknown action", () => {
    const actions = [
      [],
      [click.actions[0]!, click.actions[0]!],
      [{ actionId: "approval.maybe", value: "approval-1" }],
    ];
    for (const clicked of actions) {
      expect(decide({ ...click, actions: clicked }, installation, pendingApproval(), at)).toEqual({
        kind: "ignored",
        reason: "unknown_action",
      });
    }
  });

  test("a click on anything but the approval's own card is ignored", () => {
    const elsewhere = [
      { message: { channelId: "C-other", ts: "1000.000100" } },
      { message: { channelId: "C-link", ts: "1000.000200" } },
      { message: null },
      { actions: [{ actionId: APPROVE_ACTION_ID, value: "approval-2" }] },
      { actions: [{ actionId: APPROVE_ACTION_ID, value: null }] },
    ];
    for (const changes of elsewhere) {
      expect(decide({ ...click, ...changes }, installation, pendingApproval(), at)).toEqual({
        kind: "ignored",
        reason: "unknown_card",
      });
    }
    expect(decide(click, installation, null, at)).toEqual({
      kind: "ignored",
      reason: "unknown_card",
    });
    const unposted = pendingApproval({ card: { channelId: "C-link", ts: null } });
    expect(decide(click, installation, unposted, at)).toEqual({
      kind: "ignored",
      reason: "unknown_card",
    });
  });

  test("a stranger's click changes nothing, so the card stays pending", () => {
    expect(decide({ ...click, userId: "U-mallory" }, installation, pendingApproval(), at)).toEqual({
      kind: "ignored",
      reason: "not_owner",
    });
  });

  test("only the owner the card asked can decide it, even after a handoff", () => {
    const handedOff = { ...installation, ownerUserId: "U-next" };
    expect(decide({ ...click, userId: "U-next" }, handedOff, pendingApproval(), at)).toEqual({
      kind: "ignored",
      reason: "not_owner",
    });
    expect(decide(click, handedOff, pendingApproval(), at)).toEqual({
      kind: "ignored",
      reason: "not_owner",
    });
    expect(decide(click, { ...installation, ownerUserId: null }, pendingApproval(), at)).toEqual({
      kind: "ignored",
      reason: "not_owner",
    });
  });

  test("the owner's repeated or redelivered click on a decided card does nothing", () => {
    for (const state of ["approved", "applied", "rejected", "expired", "stale"] as const) {
      const decided = pendingApproval({ state, decidedBy: "U-owner", decidedAt: 1 });
      expect(decide(click, installation, decided, at)).toEqual({ kind: "unchanged" });
      expect(decide({ ...click, userId: "U-mallory" }, installation, decided, at)).toEqual({
        kind: "ignored",
        reason: "not_owner",
      });
    }
  });

  test("the owner's click after the hour expires the card, so the lead hears the outcome", () => {
    expect(decide(click, installation, pendingApproval(), APPROVAL_LIFETIME_MS)).toEqual({
      kind: "settled",
      approval: pendingApproval({
        state: "expired",
        decidedBy: "U-owner",
        decidedAt: APPROVAL_LIFETIME_MS,
      }),
    });
    expect(
      decide(
        { ...click, userId: "U-mallory" },
        installation,
        pendingApproval(),
        APPROVAL_LIFETIME_MS,
      ),
    ).toEqual({ kind: "ignored", reason: "not_owner" });
  });
});

describe("whether a read-set still holds", () => {
  const readSet = pendingApproval().readSet;
  const current: CurrentFacts = {
    home: { teamId: "T-home" },
    ownerUserId: "U-owner",
    link: { id: "link", status: "active", statusReason: null },
    monitored: channelFacts(),
    publish: channelFacts(),
    values: { "allowlist.U-carol": null },
  };

  test("unchanged facts hold, and so do changes the card didn't show", () => {
    expect(changedSince(readSet, current)).toBeNull();
    expect(changedSince(readSet, { ...current, values: {} })).toBeNull();
    expect(changedSince(readSet, { ...current, monitored: channelFacts({ name: "x" }) })).toBe(
      null,
    );
    expect(
      changedSince(readSet, {
        ...current,
        monitored: channelFacts({ sharedTeamIds: [], contextTeamId: null }),
      }),
    ).toBeNull();
    expect(
      changedSince(readSet, {
        ...current,
        values: { ...current.values, "allowlist.U-dave": { label: null } },
      }),
    ).toBeNull();
  });

  test("another owner fails the read-set", () => {
    expect(changedSince(readSet, { ...current, ownerUserId: "U-next" })).toBe("owner_changed");
    expect(changedSince(readSet, { ...current, ownerUserId: null })).toBe("owner_changed");
  });

  test("a link that went away, came back as another, or changed status fails it", () => {
    const changes = [
      "none" as const,
      { id: "link-2", status: "active" as const, statusReason: null },
      { id: "link", status: "paused" as const, statusReason: null },
      { id: "link", status: "active" as const, statusReason: "resumed" },
    ];
    for (const link of changes) {
      expect(changedSince(readSet, { ...current, link })).toBe("link_changed");
    }
  });

  test("either channel's audience changing fails it", () => {
    const changes = [
      { monitored: channelFacts({ kind: "public" }) },
      { publish: channelFacts({ isPendingExtShared: true }) },
      { publish: channelFacts({ id: "C-elsewhere" }) },
      { publish: channelFacts({ sharedTeamIds: ["T-home", "T-sibling"], isOrgShared: true }) },
      { monitored: channelFacts({ sharedTeamIds: [], contextTeamId: "T-other" }) },
      { monitored: channelFacts({ kind: "im" }) },
      { monitored: null },
    ];
    for (const facts of changes) {
      expect(changedSince(readSet, { ...current, ...facts })).toBe("audience_changed");
    }
  });

  test("a patched field that moved off its before value fails it, even if it may move back", () => {
    expect(
      changedSince(readSet, { ...current, values: { "allowlist.U-carol": { label: "x" } } }),
    ).toBe("setting_changed");
  });
});

describe("whether a change can apply", () => {
  const allow = pendingApproval();
  const link = pendingApproval({ action: "link", linkId: null });
  const resume = pendingApproval({
    action: "resume",
    patch: [{ field: "status", after: "active" }],
  });
  const move = pendingApproval({
    action: "set",
    patch: [{ field: "publish_channel_id", after: "C-releases" }],
  });
  const orgShared = channelFacts({
    isOrgShared: true,
    enterpriseId: "E-org",
    sharedTeamIds: ["T-home", "T-sibling"],
  });
  const facts: ProposalFacts = {
    home: { teamId: "T-home", enterpriseId: null },
    monitored: channelFacts(),
    publish: channelFacts(),
    approved: { monitored: privateAudience(), publish: privateAudience() },
    ownerInMonitored: true,
    ownerInPublish: true,
    provider: "copilot",
    routine: "present",
    linkedElsewhere: false,
    admits: [],
  };

  test("channels in the workspace with the bot and the owner, a Copilot lead and its routine can apply", () => {
    expect(invalid(allow, facts)).toBeNull();
    expect(invalid(allow, { ...facts, routine: "drifted" })).toBeNull();
    expect(invalid(link, { ...facts, approved: null })).toBeNull();
    expect(
      invalid(move, { ...facts, publish: channelFacts({ id: "C-releases", kind: "public" }) }),
    ).toBeNull();
  });

  test("each channel must exist, be a channel with the bot in it, and not be archived", () => {
    for (const channel of ["monitored", "publish"] as const) {
      expect(invalid(allow, { ...facts, [channel]: null })).toBe("channel_not_found");
      expect(invalid(allow, { ...facts, [channel]: channelFacts({ kind: "mpim" }) })).toBe(
        "not_a_channel",
      );
      expect(invalid(allow, { ...facts, [channel]: channelFacts({ isArchived: true }) })).toBe(
        "channel_archived",
      );
      expect(invalid(allow, { ...facts, [channel]: channelFacts({ isMember: false }) })).toBe(
        "bot_not_member",
      );
    }
  });

  test("a channel shared with another organization is refused, even while the share is pending", () => {
    for (const channel of ["monitored", "publish"] as const) {
      for (const shared of [{ isExtShared: true }, { isPendingExtShared: true }]) {
        expect(invalid(link, { ...facts, approved: null, [channel]: channelFacts(shared) })).toBe(
          "channel_external",
        );
        expect(invalid(resume, { ...facts, [channel]: channelFacts(shared) })).toBe(
          "channel_external",
        );
      }
    }
  });

  test("an org-shared channel can be linked only inside the installation's own org", () => {
    const linking = { ...facts, approved: null, monitored: orgShared, publish: orgShared };
    expect(invalid(link, { ...linking, home: { teamId: "T-home", enterpriseId: "E-org" } })).toBe(
      null,
    );
    expect(invalid(link, linking)).toBe("channel_other_org");
    expect(invalid(link, { ...linking, home: { teamId: "T-home", enterpriseId: "E-other" } })).toBe(
      "channel_other_org",
    );
  });

  test("a channel in another workspace, or a shared one whose workspaces Slack didn't list, is refused", () => {
    const elsewhere = channelFacts({ contextTeamId: "T-other", sharedTeamIds: [] });
    const unlisted = channelFacts({ contextTeamId: null, sharedTeamIds: [] });
    expect(invalid(link, { ...facts, approved: null, monitored: elsewhere })).toBe(
      "channel_other_workspace",
    );
    expect(invalid(link, { ...facts, approved: null, publish: unlisted })).toBeNull();
    expect(
      invalid(link, {
        ...facts,
        home: { teamId: "T-home", enterpriseId: "E-org" },
        approved: null,
        publish: { ...unlisted, isOrgShared: true, enterpriseId: "E-org" },
      }),
    ).toBe("workspaces_unknown");
  });

  test("a change can't carry through a widening of a channel it doesn't approve anew", () => {
    const madePublic = channelFacts({ kind: "public" });
    expect(invalid(allow, { ...facts, monitored: madePublic })).toBe("channel_made_public");
    expect(invalid(move, { ...facts, monitored: madePublic })).toBe("channel_made_public");
    expect(invalid(allow, { ...facts, publish: madePublic })).toBe("channel_made_public");
    expect(
      invalid(allow, {
        ...facts,
        home: { teamId: "T-home", enterpriseId: "E-org" },
        monitored: orgShared,
      }),
    ).toBe("workspace_joined");
  });

  test("link and resume approve both audiences anew, and moving publish approves its own", () => {
    const madePublic = channelFacts({ kind: "public" });
    expect(invalid(resume, { ...facts, monitored: madePublic, publish: madePublic })).toBeNull();
    expect(invalid(link, { ...facts, monitored: madePublic, publish: madePublic })).toBeNull();
    expect(invalid(move, { ...facts, publish: madePublic })).toBeNull();
  });

  test("the owner must be in both channels", () => {
    expect(invalid(allow, { ...facts, ownerInMonitored: false })).toBe("owner_not_member");
    expect(invalid(allow, { ...facts, ownerInPublish: false })).toBe("owner_not_member");
  });

  test("the Toy Box channel must be there, its lead on Copilot with its requests routine, on no other link", () => {
    expect(invalid(allow, { ...facts, provider: "anthropic" })).toBe("provider");
    expect(invalid(allow, { ...facts, provider: null })).toBe("toybox_channel_deleted");
    expect(invalid(allow, { ...facts, routine: "missing" })).toBe("routine_missing");
    expect(invalid(allow, { ...facts, linkedElsewhere: true })).toBe("already_linked");
  });

  test("everyone the change admits must pass the admission check", () => {
    const admits = (person: ReturnType<typeof slackPerson> | null) => ({
      ...facts,
      admits: [
        { userId: "U-dave", person: slackPerson({ id: "U-dave" }) },
        { userId: "U-carol", person },
      ],
    });
    expect(invalid(allow, admits(slackPerson()))).toBeNull();
    expect(invalid(allow, admits(null))).toBe("user_not_found");
    expect(invalid(allow, admits(slackPerson({ isUltraRestricted: true })))).toBe("guest");
    expect(invalid(allow, admits(slackPerson({ deleted: true })))).toBe("deactivated");
    expect(invalid(allow, admits(slackPerson({ teamId: "T-other" })))).toBe("other_workspace");
  });

  test("someone is admitted only under the ID Slack gives them, not their org-wide one", () => {
    const person = slackPerson({ id: "U-carol", enterpriseUserId: "W-carol" });
    const named = (userId: string) => ({ ...facts, admits: [{ userId, person }] });
    expect(invalid(allow, named("U-carol"))).toBeNull();
    expect(invalid(allow, named("W-carol"))).toBe("other_id");
    expect(invalid(allow, named("U-someone-else"))).toBe("unverified");
  });
});

describe("narrowing changes", () => {
  const resume = pendingApproval({
    action: "resume",
    patch: [{ field: "status", after: "active" }],
  });
  const widen = pendingApproval({
    action: "set",
    patch: [
      { field: "request_mode", after: "all" },
      { field: "observe", after: "channel" },
    ],
  });

  test("deny voids allowing that person on that link, and nobody else", () => {
    expect(reverses({ kind: "deny", linkId: "link", userId: "U-carol" }, pendingApproval())).toBe(
      true,
    );
    expect(reverses({ kind: "deny", linkId: "link", userId: "U-dave" }, pendingApproval())).toBe(
      false,
    );
    expect(reverses({ kind: "deny", linkId: "link-2", userId: "U-carol" }, pendingApproval())).toBe(
      false,
    );
  });

  test("pause voids resume", () => {
    expect(reverses({ kind: "pause", linkId: "link" }, resume)).toBe(true);
    expect(reverses({ kind: "pause", linkId: "link" }, pendingApproval())).toBe(false);
  });

  test("a narrowing set voids any card that changes one of its fields", () => {
    expect(reverses({ kind: "set", linkId: "link", fields: ["observe"] }, widen)).toBe(true);
    expect(reverses({ kind: "set", linkId: "link", fields: ["publish_channel_id"] }, widen)).toBe(
      false,
    );
  });

  test("unlink voids every card for the link, and a handoff every card at all", () => {
    for (const card of [pendingApproval(), resume, widen]) {
      expect(reverses({ kind: "unlink", linkId: "link" }, card)).toBe(true);
      expect(reverses({ kind: "unlink", linkId: "link-2" }, card)).toBe(false);
      expect(reverses({ kind: "owner" }, { ...card, linkId: "link-2" })).toBe(true);
    }
  });

  test("an approved card is voided too, but a closed one stays as it is", () => {
    const deny = { kind: "deny", linkId: "link", userId: "U-carol" } as const;
    expect(
      reverses(deny, pendingApproval({ state: "approved", decidedBy: "U-owner", decidedAt: 1 })),
    ).toBe(true);
    for (const state of ["applied", "rejected", "expired", "stale"] as const) {
      expect(reverses(deny, pendingApproval({ state }))).toBe(false);
      expect(reverses({ kind: "owner" }, pendingApproval({ state }))).toBe(false);
    }
  });
});

describe("settings", () => {
  const settings: LinkSettings = {
    slackChannelId: "C-link",
    publishChannelId: "C-link",
    requestMode: "mention",
    observe: "requesters",
  };

  test("a change patches only the fields it changes", () => {
    expect(settingsPatch(settings, { requestMode: "mention", observe: "channel" })).toEqual([
      { field: "observe", after: "channel" },
    ]);
    expect(settingsPatch(settings, {})).toEqual([]);
    expect(
      settingsPatch(settings, {
        requestMode: "all",
        observe: "channel",
        publishChannelId: "C-releases",
      }),
    ).toEqual([
      { field: "request_mode", after: "all" },
      { field: "observe", after: "channel" },
      { field: "publish_channel_id", after: "C-releases" },
    ]);
  });

  test("answering every message, keeping everyone's text or publishing elsewhere widens", () => {
    expect(narrows({ field: "request_mode", after: "all" }, settings)).toBe(false);
    expect(narrows({ field: "observe", after: "channel" }, settings)).toBe(false);
    expect(narrows({ field: "publish_channel_id", after: "C-releases" }, settings)).toBe(false);
  });

  test("answering only mentions, keeping only requesters or publishing back home narrows", () => {
    const wide = { ...settings, requestMode: "all", observe: "channel" } as const;
    expect(narrows({ field: "request_mode", after: "mention" }, wide)).toBe(true);
    expect(narrows({ field: "observe", after: "requesters" }, wide)).toBe(true);
    const elsewhere = { ...settings, publishChannelId: "C-releases" };
    expect(narrows({ field: "publish_channel_id", after: "C-link" }, elsewhere)).toBe(true);
  });
});

describe("proposing a change", () => {
  const draft = {
    toyboxChannelId: "toybox-link",
    linkId: "link",
    action: "set" as const,
    patch: [
      { field: "request_mode" as const, after: "all" },
      { field: "observe" as const, after: "channel" },
    ],
  };
  const pending = (number: number, patch = draft.patch) =>
    pendingApproval({ id: `approval-${number}`, number, action: "set", patch });

  test("a new change with room under the limits can be proposed", () => {
    expect(checkProposal(draft, [], 0)).toEqual({ kind: "new" });
    expect(checkProposal(draft, [pendingApproval()], 9)).toEqual({ kind: "new" });
  });

  test("proposing the same change again returns the open one, whatever the patch order", () => {
    const open = pending(4, draft.patch.toReversed());
    expect(checkProposal(draft, [pendingApproval(), open], 0)).toEqual({
      kind: "existing",
      approval: open,
    });
    expect(checkProposal(draft, [open], 10)).toEqual({
      kind: "existing",
      approval: open,
    });
  });

  test("a change to a field another open approval changes is refused", () => {
    const observing = pending(4, [{ field: "observe", after: "channel" }]);
    expect(checkProposal(draft, [observing], 0)).toEqual({ kind: "refused", reason: "overlap" });
    const approved = { ...observing, state: "approved" as const };
    expect(checkProposal(draft, [approved], 0)).toEqual({ kind: "refused", reason: "overlap" });
  });

  test("another Toy Box channel's approvals change its own link, so they never match or overlap", () => {
    const elsewhere = { ...pending(4), toyboxChannelId: "toybox-other", linkId: "link-other" };
    expect(checkProposal(draft, [elsewhere], 0)).toEqual({ kind: "new" });
    const allowing = { ...draft, action: "allow" as const, patch: pendingApproval().patch };
    expect(
      checkProposal(allowing, [{ ...pendingApproval(), toyboxChannelId: "toybox-other" }], 0),
    ).toEqual({ kind: "new" });
  });

  test("handing ownership on overlaps any other handoff, from any Toy Box channel", () => {
    const handoff = (toyboxChannelId: string, userId: string) => ({
      ...pendingApproval({ id: `handoff-${toyboxChannelId}`, action: "owner" }),
      toyboxChannelId,
      patch: [{ field: "owner_user_id" as const, after: userId }],
    });
    const draft = { ...handoff("toybox-link", "U-dave"), linkId: "link" };
    expect(checkProposal(draft, [handoff("toybox-link", "U-dave")], 0)).toMatchObject({
      kind: "existing",
    });
    expect(checkProposal(draft, [handoff("toybox-other", "U-dave")], 0)).toEqual({
      kind: "refused",
      reason: "overlap",
    });
    expect(checkProposal(draft, [handoff("toybox-other", "U-erin")], 0)).toEqual({
      kind: "refused",
      reason: "overlap",
    });
  });

  test("linking a Slack channel is refused while any open approval links it, from any Toy Box channel", () => {
    const linking = (toyboxChannelId: string, slackChannelId: string) => ({
      ...pendingApproval({ id: `link-${toyboxChannelId}`, action: "link", linkId: null }),
      toyboxChannelId,
      patch: [
        { field: "slack_channel_id" as const, after: slackChannelId },
        { field: "publish_channel_id" as const, after: slackChannelId },
      ],
    });
    const draft = { ...linking("toybox-new", "C-eng"), linkId: null };
    expect(checkProposal(draft, [linking("toybox-other", "C-eng")], 0)).toEqual({
      kind: "refused",
      reason: "overlap",
    });
    const approved = { ...linking("toybox-other", "C-eng"), state: "approved" as const };
    expect(checkProposal(draft, [approved], 0)).toEqual({ kind: "refused", reason: "overlap" });
    expect(checkProposal(draft, [linking("toybox-other", "C-design")], 0)).toEqual({
      kind: "new",
    });
    // Its own Toy Box channel links one Slack channel at a time.
    expect(checkProposal(draft, [linking("toybox-new", "C-design")], 0)).toEqual({
      kind: "refused",
      reason: "overlap",
    });
  });

  test("the limits count only the draft's own Toy Box channel", () => {
    const others = [1, 2, 3].map((number) => ({
      ...pendingApproval({ id: `approval-${number}`, number, patch: [] }),
      toyboxChannelId: "toybox-other",
    }));
    expect(checkProposal(draft, others, 0)).toEqual({ kind: "new" });
  });

  test("a fourth pending approval is refused, while approved ones don't count", () => {
    const others = [1, 2, 3].map((number) =>
      pendingApproval({ id: `approval-${number}`, number, patch: [] }),
    );
    expect(checkProposal(draft, others.slice(0, 2), 0)).toEqual({ kind: "new" });
    expect(checkProposal(draft, others, 0)).toEqual({
      kind: "refused",
      reason: "too_many_pending",
    });
    const approved = { ...others[2]!, state: "approved" as const };
    expect(checkProposal(draft, [...others.slice(0, 2), approved], 0)).toEqual({ kind: "new" });
  });

  test("an eleventh proposal within the hour is refused", () => {
    expect(checkProposal(draft, [], 10)).toEqual({
      kind: "refused",
      reason: "too_many_created",
    });
  });

  test("a proposal allowing more people than one card shows is refused, before anything else", () => {
    const allowing = (count: number) => ({
      ...draft,
      action: "allow" as const,
      patch: Array.from({ length: count }, (_, index) => ({
        field: allowlistField(`U-${index}`),
        after: { label: null },
      })),
    });
    expect(checkProposal(allowing(20), [], 0)).toEqual({ kind: "new" });
    expect(checkProposal(allowing(21), [], 10)).toEqual({
      kind: "refused",
      reason: "too_many_people",
    });
  });

  test("widening waits for an owner who posted in Toy Box within half an hour", () => {
    expect(ownerPresent(0, 30 * 60_000)).toBe(true);
    expect(ownerPresent(0, 30 * 60_000 + 1)).toBe(false);
    expect(ownerPresent(null, 0)).toBe(false);
  });
});

test("an allowlist entry is a field of its own for each person", () => {
  expect(allowlistField("U-carol")).toBe("allowlist.U-carol");
  expect(allowlistUser(allowlistField("U-carol"))).toBe("U-carol");
  expect(allowlistUser("owner_user_id")).toBeNull();
  expect(allowlistUser("request_mode")).toBeNull();
});
