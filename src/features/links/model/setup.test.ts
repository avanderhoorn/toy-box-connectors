import { describe, expect, test } from "bun:test";
import { channelFacts, slackPerson } from "@slackapi/model/testFixtures";
import type { ToyBoxRoutine } from "@toybox/model";
import type { Approval, InvalidReason, LinkField } from "./approvals";
import {
  draftSetup,
  factsNeeded,
  judgeApply,
  planProposal,
  proposalFacts,
  valueOf,
  type FreshFacts,
  type ProposalContext,
  type SetupDraft,
  type SetupLink,
  type SetupRequest,
  type SetupState,
} from "./setup";
import { pendingApproval, privateAudience } from "./testFixtures";

const installation: SetupState["installation"] = {
  teamId: "T-home",
  enterpriseId: null,
  ownerUserId: "U-owner",
  status: "active",
};

/** toybox-link's active link, watching and publishing in C-link, with U-dave allowed as design. */
const link: SetupLink = {
  id: "link",
  slackChannelId: "C-link",
  publishChannelId: "C-link",
  requestMode: "mention",
  observe: "requesters",
  status: "active",
  statusReason: null,
  requestsRoutineId: "routine-requests",
  approved: { monitored: privateAudience(), publish: privateAudience() },
  allowlist: new Map([["U-dave", { label: "design" }]]),
};

const linked: SetupState = {
  installation,
  slackUsable: true,
  toyboxChannelId: "toybox-link",
  link,
};
const unlinked: SetupState = { ...linked, link: null };

const requestsRoutine: ToyBoxRoutine = {
  id: "routine-requests",
  title: "Slack requests",
  schedule: "*/5 * * * *",
  prompt: "Run `toy-box-slack inbox` and answer what it shows.",
};

/** Everything fresh for allowing U-carol on the link: C-link as before, and a present owner. */
const fresh: FreshFacts = {
  monitored: channelFacts(),
  publish: channelFacts(),
  ownerInMonitored: true,
  ownerInPublish: true,
  people: [{ userId: "U-carol", person: slackPerson() }],
  toyBox: { provider: "copilot", ownerSpokeAt: 0, routines: [requestsRoutine] },
};

const linkRequest: SetupRequest = {
  action: "link",
  slackChannelId: "C-new",
  routineId: "routine-requests",
  allow: [],
};

function withLink(changes: Partial<SetupLink>): SetupState {
  return { ...linked, link: { ...link, ...changes } };
}

function proposed(draft: SetupDraft): Extract<SetupDraft, { kind: "proposal" }> {
  if (draft.kind !== "proposal") throw new Error(`Drafted ${draft.kind}, not a proposal.`);
  return draft;
}

function approved(changes: Partial<Approval> = {}): Approval {
  return pendingApproval({
    state: "approved",
    decidedBy: "U-owner",
    decidedAt: 60_000,
    ...changes,
  });
}

describe("drafting a setup command", () => {
  test("nothing is drafted while Slack rejects the bridge, or before anyone claimed it", () => {
    const allow: SetupRequest = { action: "allow", userIds: ["U-carol"] };
    for (const status of ["auth_failed", "uninstalled"] as const) {
      const state = { ...linked, installation: { ...installation, status, ownerUserId: null } };
      expect(draftSetup(state, allow)).toEqual({ kind: "refused", reason: "not_connected" });
    }
    const unclaimed = { ...installation, ownerUserId: null };
    expect(draftSetup({ ...linked, installation: unclaimed }, allow)).toEqual({
      kind: "refused",
      reason: "no_owner",
    });
    expect(draftSetup({ ...unlinked, installation: unclaimed }, linkRequest)).toEqual({
      kind: "refused",
      reason: "no_owner",
    });
  });

  test("nothing is drafted until the bridge can use Slack, whatever the installation says", () => {
    const connecting = { ...linked, slackUsable: false };
    const requests: SetupRequest[] = [
      { action: "allow", userIds: ["U-carol"] },
      { action: "set", change: { requestMode: "all" } },
      { action: "resume" },
      { action: "owner", userId: "U-carol" },
    ];
    for (const request of requests) {
      expect(draftSetup(connecting, request)).toEqual({ kind: "refused", reason: "not_connected" });
    }
    expect(draftSetup({ ...connecting, link: null }, linkRequest)).toEqual({
      kind: "refused",
      reason: "not_connected",
    });
  });

  test("a set that only narrows needs neither Slack nor an owner, but one that widens needs both", () => {
    const narrow: SetupRequest = { action: "set", change: { requestMode: "mention" } };
    const widen: SetupRequest = { action: "set", change: { observe: "channel" } };
    const all = withLink({ requestMode: "all" });
    const stopped = [
      [{ ...all, slackUsable: false }, "not_connected"],
      [{ ...all, installation: { ...installation, status: "auth_failed" } }, "not_connected"],
      [{ ...all, installation: { ...installation, ownerUserId: null } }, "no_owner"],
    ] as const;
    for (const [state, reason] of stopped) {
      expect(draftSetup(state, narrow)).toEqual({
        kind: "narrowing",
        linkId: "link",
        patch: [{ field: "request_mode", after: "mention" }],
      });
      expect(draftSetup(state, { action: "set", change: {} })).toEqual({ kind: "unchanged" });
      expect(draftSetup(state, widen)).toEqual({ kind: "refused", reason });
      expect(draftSetup({ ...state, link: null }, narrow)).toEqual({ kind: "refused", reason });
    }
  });

  test("every command but link needs a link, and a Toy Box channel has one link whatever its status", () => {
    const requests: SetupRequest[] = [
      { action: "allow", userIds: ["U-carol"] },
      { action: "set", change: { requestMode: "mention" } },
      { action: "resume" },
      { action: "owner", userId: "U-carol" },
    ];
    for (const request of requests) {
      expect(draftSetup(unlinked, request)).toEqual({ kind: "refused", reason: "not_linked" });
    }
    for (const status of ["active", "paused", "suspended"] as const) {
      expect(draftSetup(withLink({ status }), linkRequest)).toEqual({
        kind: "refused",
        reason: "already_linked",
      });
    }
  });
});

describe("linking a Slack channel", () => {
  test("a link holds every setting, publishing where it watches and answering mentions from requesters unless asked", () => {
    expect(draftSetup(unlinked, linkRequest)).toEqual({
      kind: "proposal",
      proposal: {
        toyboxChannelId: "toybox-link",
        linkId: null,
        action: "link",
        patch: [
          { field: "slack_channel_id", after: "C-new" },
          { field: "publish_channel_id", after: "C-new" },
          { field: "request_mode", after: "mention" },
          { field: "observe", after: "requesters" },
          { field: "requests_routine_id", after: "routine-requests" },
        ],
      },
      needed: {
        monitored: "C-new",
        publish: "C-new",
        owner: "U-owner",
        people: [],
        routineId: "routine-requests",
      },
    });
  });

  test("a link can publish elsewhere, answer every message and keep the whole channel's text", () => {
    const draft = proposed(
      draftSetup(unlinked, {
        ...linkRequest,
        publishChannelId: "C-releases",
        requestMode: "all",
        observe: "channel",
      }),
    );
    expect(draft.proposal.patch.slice(1, 4)).toEqual([
      { field: "publish_channel_id", after: "C-releases" },
      { field: "request_mode", after: "all" },
      { field: "observe", after: "channel" },
    ]);
    expect(draft.needed).toMatchObject({ monitored: "C-new", publish: "C-releases" });
  });

  test("a link allows each person it names once, never the owner, and asks Slack about each", () => {
    const draft = proposed(
      draftSetup(unlinked, { ...linkRequest, allow: ["U-carol", "U-owner", "U-carol", "U-erin"] }),
    );
    expect(draft.proposal.patch.slice(5)).toEqual([
      { field: "allowlist.U-carol", after: { label: null } },
      { field: "allowlist.U-erin", after: { label: null } },
    ]);
    expect(draft.needed.people).toEqual(["U-carol", "U-erin"]);
  });
});

describe("allowing people", () => {
  test("someone new is allowed with the label given, or none, and checked against the link's channels", () => {
    expect(draftSetup(linked, { action: "allow", userIds: ["U-carol"], label: "qa" })).toEqual({
      kind: "proposal",
      proposal: {
        toyboxChannelId: "toybox-link",
        linkId: "link",
        action: "allow",
        patch: [{ field: "allowlist.U-carol", after: { label: "qa" } }],
      },
      needed: {
        monitored: "C-link",
        publish: "C-link",
        owner: "U-owner",
        people: ["U-carol"],
        routineId: "routine-requests",
      },
    });
    expect(
      proposed(draftSetup(linked, { action: "allow", userIds: ["U-carol"] })).proposal.patch,
    ).toEqual([{ field: "allowlist.U-carol", after: { label: null } }]);
  });

  test("someone allowed already keeps their label unless given another", () => {
    expect(draftSetup(linked, { action: "allow", userIds: ["U-dave"] })).toEqual({
      kind: "unchanged",
    });
    expect(draftSetup(linked, { action: "allow", userIds: ["U-dave"], label: "design" })).toEqual({
      kind: "unchanged",
    });
    expect(
      proposed(draftSetup(linked, { action: "allow", userIds: ["U-dave"], label: "release" }))
        .proposal.patch,
    ).toEqual([{ field: "allowlist.U-dave", after: { label: "release" } }]);
    const unlabelled = withLink({ allowlist: new Map([["U-dave", { label: null }]]) });
    expect(draftSetup(unlabelled, { action: "allow", userIds: ["U-dave"] })).toEqual({
      kind: "unchanged",
    });
  });

  test("allowing the owner changes nothing, and someone named twice is allowed once", () => {
    expect(draftSetup(linked, { action: "allow", userIds: ["U-owner"] })).toEqual({
      kind: "unchanged",
    });
    const draft = proposed(
      draftSetup(linked, { action: "allow", userIds: ["U-carol", "U-owner", "U-dave", "U-carol"] }),
    );
    expect(draft.proposal.patch).toEqual([{ field: "allowlist.U-carol", after: { label: null } }]);
    expect(draft.needed.people).toEqual(["U-carol"]);
  });
});

describe("changing settings", () => {
  const wide = withLink({ publishChannelId: "C-releases", requestMode: "all", observe: "channel" });

  test("a set that only narrows applies at once", () => {
    expect(
      draftSetup(wide, {
        action: "set",
        change: { requestMode: "mention", observe: "requesters", publishChannelId: "C-link" },
      }),
    ).toEqual({
      kind: "narrowing",
      linkId: "link",
      patch: [
        { field: "request_mode", after: "mention" },
        { field: "observe", after: "requesters" },
        { field: "publish_channel_id", after: "C-link" },
      ],
    });
  });

  test("a set that widens anything asks the owner about all of it", () => {
    expect(draftSetup(linked, { action: "set", change: { requestMode: "all" } })).toEqual({
      kind: "proposal",
      proposal: {
        toyboxChannelId: "toybox-link",
        linkId: "link",
        action: "set",
        patch: [{ field: "request_mode", after: "all" }],
      },
      needed: {
        monitored: "C-link",
        publish: "C-link",
        owner: "U-owner",
        people: [],
        routineId: "routine-requests",
      },
    });
    const both = proposed(
      draftSetup(withLink({ requestMode: "all" }), {
        action: "set",
        change: { requestMode: "mention", observe: "channel" },
      }),
    );
    expect(both.proposal.patch).toEqual([
      { field: "request_mode", after: "mention" },
      { field: "observe", after: "channel" },
    ]);
  });

  test("moving the publish channel anywhere but the watched one is checked against the new one", () => {
    const move = proposed(
      draftSetup(linked, { action: "set", change: { publishChannelId: "C-releases" } }),
    );
    expect(move.proposal.patch).toEqual([{ field: "publish_channel_id", after: "C-releases" }]);
    expect(move.needed).toMatchObject({ monitored: "C-link", publish: "C-releases" });
  });

  test("a set to the values the link has changes nothing", () => {
    expect(draftSetup(linked, { action: "set", change: {} })).toEqual({ kind: "unchanged" });
    expect(
      draftSetup(linked, {
        action: "set",
        change: { requestMode: "mention", observe: "requesters", publishChannelId: "C-link" },
      }),
    ).toEqual({ kind: "unchanged" });
  });
});

describe("resuming a link", () => {
  test("a paused or suspended link resumes once the owner approves", () => {
    const stopped = [
      withLink({ status: "paused" }),
      withLink({ status: "suspended", statusReason: "channel_made_public" }),
      withLink({ status: "suspended", statusReason: "auth_failed" }),
    ];
    for (const state of stopped) {
      expect(draftSetup(state, { action: "resume" })).toEqual({
        kind: "proposal",
        proposal: {
          toyboxChannelId: "toybox-link",
          linkId: "link",
          action: "resume",
          patch: [{ field: "status", after: "active" }],
        },
        needed: {
          monitored: "C-link",
          publish: "C-link",
          owner: "U-owner",
          people: [],
          routineId: "routine-requests",
        },
      });
    }
  });

  test("an active link is unchanged, and one whose Toy Box channel was deleted can only be unlinked", () => {
    expect(draftSetup(linked, { action: "resume" })).toEqual({ kind: "unchanged" });
    const orphaned = withLink({ status: "suspended", statusReason: "toybox_channel_deleted" });
    expect(draftSetup(orphaned, { action: "resume" })).toEqual({
      kind: "refused",
      reason: "toybox_channel_deleted",
    });
  });
});

describe("handing the bridge to a new owner", () => {
  test("a new owner is checked as a person and must be in the link's channels", () => {
    expect(draftSetup(linked, { action: "owner", userId: "U-carol" })).toEqual({
      kind: "proposal",
      proposal: {
        toyboxChannelId: "toybox-link",
        linkId: "link",
        action: "owner",
        patch: [{ field: "owner_user_id", after: "U-carol" }],
      },
      needed: {
        monitored: "C-link",
        publish: "C-link",
        owner: "U-carol",
        people: ["U-carol"],
        routineId: "routine-requests",
      },
    });
  });

  test("naming the owner the bridge has changes nothing", () => {
    expect(draftSetup(linked, { action: "owner", userId: "U-owner" })).toEqual({
      kind: "unchanged",
    });
  });
});

describe("a patched field's value", () => {
  test("each field reads the link, and the owner the installation", () => {
    const values: Record<LinkField, string> = {
      slack_channel_id: "C-link",
      publish_channel_id: "C-releases",
      request_mode: "all",
      observe: "channel",
      requests_routine_id: "routine-requests",
      status: "paused",
    };
    const state = withLink({
      publishChannelId: "C-releases",
      requestMode: "all",
      observe: "channel",
      status: "paused",
    });
    for (const [field, value] of Object.entries(values)) {
      expect(valueOf(state, field as LinkField)).toBe(value);
    }
    expect(valueOf(state, "owner_user_id")).toBe("U-owner");
    expect(
      valueOf({ ...state, installation: { ...installation, ownerUserId: null } }, "owner_user_id"),
    ).toBeNull();
  });

  test("an allowlist entry is its label, so someone allowed without one differs from someone absent", () => {
    const state = withLink({ allowlist: new Map([["U-dave", { label: null }]]) });
    expect(valueOf(linked, "allowlist.U-dave")).toEqual({ label: "design" });
    expect(valueOf(state, "allowlist.U-dave")).toEqual({ label: null });
    expect(valueOf(state, "allowlist.U-carol")).toBeNull();
  });

  test("every field of a link that doesn't exist is null", () => {
    const fields = [
      "slack_channel_id",
      "publish_channel_id",
      "request_mode",
      "observe",
      "requests_routine_id",
      "status",
      "allowlist.U-dave",
    ] as const;
    for (const field of fields) expect(valueOf(unlinked, field)).toBeNull();
    expect(valueOf(unlinked, "owner_user_id")).toBe("U-owner");
  });
});

describe("the facts a change needs", () => {
  test("what its patch sets, and the link's own settings for the rest", () => {
    const change = {
      patch: [
        { field: "publish_channel_id" as const, after: "C-releases" },
        { field: "requests_routine_id" as const, after: "routine-other" },
      ],
    };
    expect(factsNeeded(linked, change)).toEqual({
      monitored: "C-link",
      publish: "C-releases",
      owner: "U-owner",
      people: [],
      routineId: "routine-other",
    });
    expect(factsNeeded(linked, { patch: [] })).toEqual({
      monitored: "C-link",
      publish: "C-link",
      owner: "U-owner",
      people: [],
      routineId: "routine-requests",
    });
  });

  test("everyone the change allows or makes owner, once each, but nobody it removes", () => {
    const change = {
      patch: [
        { field: "allowlist.U-carol" as const, after: { label: null } },
        { field: "allowlist.U-dave" as const, after: null },
        { field: "owner_user_id" as const, after: "U-erin" },
        { field: "allowlist.U-erin" as const, after: { label: "qa" } },
      ],
    };
    expect(factsNeeded(linked, change)).toMatchObject({
      owner: "U-erin",
      people: ["U-carol", "U-erin"],
    });
  });

  test("a change with no link, or no owner, to read its facts from has none", () => {
    expect(factsNeeded(unlinked, pendingApproval())).toBeNull();
    const partLink = {
      patch: [
        { field: "slack_channel_id" as const, after: "C-new" },
        { field: "publish_channel_id" as const, after: "C-new" },
      ],
    };
    expect(factsNeeded(unlinked, partLink)).toBeNull();
    const unclaimed = { ...linked, installation: { ...installation, ownerUserId: null } };
    expect(factsNeeded(unclaimed, pendingApproval())).toBeNull();
  });
});

describe("the facts a change is checked against", () => {
  const needed = factsNeeded(linked, pendingApproval())!;

  test("both channels as Slack describes them, the audiences the owner approved and the Toy Box channel", () => {
    expect(proposalFacts(linked, { ...needed, people: ["U-carol"] }, fresh, false)).toEqual({
      home: installation,
      monitored: channelFacts(),
      publish: channelFacts(),
      approved: link.approved,
      ownerInMonitored: true,
      ownerInPublish: true,
      provider: "copilot",
      routine: "present",
      linkedElsewhere: false,
      admits: fresh.people,
    });
    const owner = { ...fresh, ownerInMonitored: false, ownerInPublish: false };
    expect(proposalFacts(unlinked, needed, owner, true)).toMatchObject({
      approved: null,
      ownerInMonitored: false,
      ownerInPublish: false,
      linkedElsewhere: true,
    });
  });

  test("a channel Slack answered for under another ID counts as one it can't find", () => {
    const moved = { ...fresh, monitored: channelFacts({ id: "C-other" }) };
    expect(proposalFacts(linked, needed, moved, false)).toMatchObject({
      monitored: null,
      publish: channelFacts(),
    });
    const elsewhere = { ...fresh, publish: channelFacts({ id: "C-other" }) };
    expect(proposalFacts(linked, needed, elsewhere, false)).toMatchObject({
      monitored: channelFacts(),
      publish: null,
    });
  });

  test("the requests routine is the one the change names, matched against the inbox command", () => {
    const routines = (prompt: string) => ({
      ...fresh,
      toyBox: { ...fresh.toyBox!, routines: [{ ...requestsRoutine, prompt }] },
    });
    expect(proposalFacts(linked, needed, routines("Summarize the day."), false).routine).toBe(
      "drifted",
    );
    const other = { ...needed, routineId: "routine-other" };
    expect(proposalFacts(linked, other, fresh, false).routine).toBe("missing");
  });

  test("a deleted Toy Box channel has no provider and no routine", () => {
    expect(proposalFacts(linked, needed, { ...fresh, toyBox: null }, false)).toMatchObject({
      provider: null,
      routine: "missing",
    });
  });
});

describe("planning a proposal", () => {
  const allow = proposed(draftSetup(linked, { action: "allow", userIds: ["U-carol"] }));
  const context: ProposalContext = { open: [], createdInLastHour: 0, linkedElsewhere: false };

  test("a valid change shows its owner, the link, both audiences and each field before it", () => {
    expect(planProposal(linked, allow, fresh, context, 0)).toEqual({
      kind: "new",
      readSet: {
        ownerUserId: "U-owner",
        link: { id: "link", status: "active", statusReason: null },
        monitored: privateAudience(),
        publish: privateAudience(),
        before: { "allowlist.U-carol": null },
      },
      cardChannelId: "C-link",
    });
  });

  test("a new link's card goes in the channel it will watch, and shows no link before it", () => {
    const draft = proposed(
      draftSetup(unlinked, { ...linkRequest, publishChannelId: "C-releases" }),
    );
    const channels = {
      ...fresh,
      monitored: channelFacts({ id: "C-new" }),
      publish: channelFacts({ id: "C-releases", kind: "public" }),
      people: [],
    };
    expect(planProposal(unlinked, draft, channels, context, 0)).toEqual({
      kind: "new",
      readSet: {
        ownerUserId: "U-owner",
        link: "none",
        monitored: privateAudience("C-new"),
        publish: { ...privateAudience("C-releases"), kind: "public" },
        before: {
          slack_channel_id: null,
          publish_channel_id: null,
          request_mode: null,
          observe: null,
          requests_routine_id: null,
        },
      },
      cardChannelId: "C-new",
    });
  });

  test("a resume shows the link stopped, with why", () => {
    const suspended = withLink({ status: "suspended", statusReason: "channel_made_public" });
    const resume = proposed(draftSetup(suspended, { action: "resume" }));
    expect(planProposal(suspended, resume, { ...fresh, people: [] }, context, 0)).toMatchObject({
      kind: "new",
      readSet: {
        link: { id: "link", status: "suspended", statusReason: "channel_made_public" },
        before: { status: "suspended" },
      },
    });
  });

  test("the same change waiting already is returned, whatever else is true", () => {
    const waiting = pendingApproval();
    const open = { ...context, open: [waiting], createdInLastHour: 10 };
    expect(planProposal(linked, allow, { ...fresh, toyBox: null }, open, 0)).toEqual({
      kind: "existing",
      approval: waiting,
    });
  });

  test("an overlapping draft, or one past the limits, is refused before Toy Box is asked", () => {
    const relabel = pendingApproval({
      patch: [{ field: "allowlist.U-carol", after: { label: "x" } }],
    });
    const gone = { ...fresh, toyBox: null };
    expect(planProposal(linked, allow, gone, { ...context, open: [relabel] }, 0)).toEqual({
      kind: "refused",
      reason: "overlap",
    });
    expect(planProposal(linked, allow, gone, { ...context, createdInLastHour: 10 }, 0)).toEqual({
      kind: "refused",
      reason: "too_many_created",
    });
  });

  test("a deleted Toy Box channel is refused before the owner's presence is asked", () => {
    expect(planProposal(linked, allow, { ...fresh, toyBox: null }, context, 0)).toEqual({
      kind: "refused",
      reason: "toybox_channel_deleted",
    });
  });

  test("the owner must have posted in the Toy Box channel within the last 30 minutes", () => {
    const spoke = (ownerSpokeAt: number | null) => ({
      ...fresh,
      toyBox: { ...fresh.toyBox!, ownerSpokeAt },
    });
    expect(planProposal(linked, allow, spoke(0), context, 30 * 60_000).kind).toBe("new");
    expect(planProposal(linked, allow, spoke(0), context, 30 * 60_000 + 1)).toEqual({
      kind: "refused",
      reason: "owner_away",
    });
    expect(planProposal(linked, allow, spoke(null), context, 0)).toEqual({
      kind: "refused",
      reason: "owner_away",
    });
  });

  test("an away owner is refused before the change itself is checked", () => {
    const away = { ...fresh, monitored: null, toyBox: { ...fresh.toyBox!, ownerSpokeAt: null } };
    expect(planProposal(linked, allow, away, context, 0)).toEqual({
      kind: "refused",
      reason: "owner_away",
    });
  });

  test("a change that isn't valid now is refused with why", () => {
    const refusal = (facts: FreshFacts, changes: Partial<ProposalContext> = {}) =>
      planProposal(linked, allow, facts, { ...context, ...changes }, 0);
    expect(refusal({ ...fresh, monitored: channelFacts({ isMember: false }) })).toEqual({
      kind: "refused",
      reason: "bot_not_member",
    });
    expect(refusal({ ...fresh, publish: channelFacts({ id: "C-other" }) })).toEqual({
      kind: "refused",
      reason: "channel_not_found",
    });
    expect(refusal({ ...fresh, monitored: channelFacts({ kind: "public" }) })).toEqual({
      kind: "refused",
      reason: "channel_made_public",
    });
    expect(refusal({ ...fresh, people: [{ userId: "U-carol", person: null }] })).toEqual({
      kind: "refused",
      reason: "user_not_found",
    });
    expect(refusal(fresh, { linkedElsewhere: true })).toEqual({
      kind: "refused",
      reason: "already_linked",
    });
    expect(refusal({ ...fresh, toyBox: { ...fresh.toyBox!, routines: [] } })).toEqual({
      kind: "refused",
      reason: "routine_missing",
    });
    expect(refusal({ ...fresh, toyBox: { ...fresh.toyBox!, provider: "anthropic" } })).toEqual({
      kind: "refused",
      reason: "provider",
    });
  });
});

describe("judging an approved change", () => {
  test("a change whose card still holds applies, keeping the audiences the owner approved before", () => {
    const wider = { ...privateAudience(), kind: "public" as const };
    const state = withLink({ approved: { monitored: wider, publish: wider } });
    expect(judgeApply(state, approved(), fresh, false)).toEqual({
      kind: "apply",
      approved: { monitored: wider, publish: wider },
      routine: "present",
    });
  });

  test("a link approves both audiences as they are now", () => {
    const draft = proposed(draftSetup(unlinked, linkRequest));
    const channels = {
      ...fresh,
      monitored: channelFacts({ id: "C-new" }),
      publish: channelFacts({ id: "C-new" }),
      people: [],
    };
    const plan = planProposal(
      unlinked,
      draft,
      channels,
      { open: [], createdInLastHour: 0, linkedElsewhere: false },
      0,
    );
    if (plan.kind !== "new") throw new Error(`Planned ${plan.kind}.`);
    const approval = approved({ ...draft.proposal, readSet: plan.readSet });
    expect(judgeApply(unlinked, approval, channels, false)).toEqual({
      kind: "apply",
      approved: { monitored: privateAudience("C-new"), publish: privateAudience("C-new") },
      routine: "present",
    });
  });

  test("resuming, or moving the publish channel, approves both audiences as they are now", () => {
    const wider = { ...privateAudience(), kind: "public" as const };
    const suspended = withLink({
      status: "suspended",
      statusReason: "channel_made_public",
      approved: { monitored: wider, publish: wider },
    });
    const resume = approved({
      action: "resume",
      patch: [{ field: "status", after: "active" }],
      readSet: {
        ownerUserId: "U-owner",
        link: { id: "link", status: "suspended", statusReason: "channel_made_public" },
        monitored: privateAudience(),
        publish: privateAudience(),
        before: { status: "suspended" },
      },
    });
    expect(judgeApply(suspended, resume, { ...fresh, people: [] }, false)).toMatchObject({
      kind: "apply",
      approved: { monitored: privateAudience(), publish: privateAudience() },
    });

    const state = withLink({ approved: { monitored: wider, publish: wider } });
    const move = approved({
      action: "set",
      patch: [{ field: "publish_channel_id", after: "C-releases" }],
      readSet: {
        ownerUserId: "U-owner",
        link: { id: "link", status: "active", statusReason: null },
        monitored: privateAudience(),
        publish: privateAudience("C-releases"),
        before: { publish_channel_id: "C-link" },
      },
    });
    const moved = { ...fresh, publish: channelFacts({ id: "C-releases" }), people: [] };
    expect(judgeApply(state, move, moved, false)).toMatchObject({
      kind: "apply",
      approved: { monitored: privateAudience(), publish: privateAudience("C-releases") },
    });
  });

  test("a drifted routine still applies, and the owner's presence isn't asked again", () => {
    const drifted = {
      ...fresh,
      toyBox: {
        provider: "copilot",
        ownerSpokeAt: null,
        routines: [{ ...requestsRoutine, prompt: "Summarize the day." }],
      },
    };
    expect(judgeApply(linked, approved(), drifted, false)).toMatchObject({
      kind: "apply",
      routine: "drifted",
    });
  });

  test("a change goes stale once the owner changed, or nobody owns the bridge", () => {
    for (const ownerUserId of ["U-erin", null]) {
      const state = { ...linked, installation: { ...installation, ownerUserId } };
      expect(judgeApply(state, approved(), fresh, false)).toEqual({
        kind: "stale",
        reason: "owner_changed",
      });
    }
  });

  test("a change goes stale once its link went away, stopped or appeared", () => {
    for (const state of [
      unlinked,
      withLink({ status: "paused" }),
      withLink({ status: "suspended", statusReason: "channel_made_public" }),
      withLink({ id: "link-2" }),
    ]) {
      expect(judgeApply(state, approved(), fresh, false)).toEqual({
        kind: "stale",
        reason: "link_changed",
      });
    }
    const linking = approved({
      action: "link",
      linkId: null,
      patch: proposed(draftSetup(unlinked, { ...linkRequest, slackChannelId: "C-link" })).proposal
        .patch,
      readSet: { ...pendingApproval().readSet, link: "none", before: {} },
    });
    expect(judgeApply(linked, linking, fresh, false)).toEqual({
      kind: "stale",
      reason: "link_changed",
    });
  });

  test("a change goes stale once either channel's audience changed, or Slack answers for another", () => {
    const changes: Partial<FreshFacts>[] = [
      { monitored: channelFacts({ kind: "public" }) },
      { publish: channelFacts({ isExtShared: true }) },
      { publish: channelFacts({ isPendingExtShared: true }) },
      { monitored: channelFacts({ id: "C-other" }) },
      { publish: null },
    ];
    for (const change of changes) {
      expect(judgeApply(linked, approved(), { ...fresh, ...change }, false)).toEqual({
        kind: "stale",
        reason: "audience_changed",
      });
    }
  });

  test("a change goes stale once a field it changes moved off the value its card showed", () => {
    const carol = withLink({ allowlist: new Map([["U-carol", { label: "x" }]]) });
    expect(judgeApply(carol, approved(), fresh, false)).toEqual({
      kind: "stale",
      reason: "setting_changed",
    });
  });

  test("a change to anything its card didn't show doesn't matter", () => {
    const erin = withLink({
      allowlist: new Map([...link.allowlist, ["U-erin", { label: null }]]),
      requestMode: "all",
    });
    expect(judgeApply(erin, approved(), fresh, false).kind).toBe("apply");
  });

  test("a change whose card still holds goes stale once it's no longer valid", () => {
    const changes: [Partial<FreshFacts>, InvalidReason][] = [
      [{ monitored: channelFacts({ isMember: false }) }, "bot_not_member"],
      [{ publish: channelFacts({ isArchived: true }) }, "channel_archived"],
      [{ ownerInPublish: false }, "owner_not_member"],
      [{ people: [{ userId: "U-carol", person: slackPerson({ deleted: true }) }] }, "deactivated"],
      [{ toyBox: { ...fresh.toyBox!, provider: "anthropic" } }, "provider"],
      [{ toyBox: null }, "toybox_channel_deleted"],
      [{ toyBox: { ...fresh.toyBox!, routines: [] } }, "routine_missing"],
    ];
    for (const [change, reason] of changes) {
      expect(judgeApply(linked, approved(), { ...fresh, ...change }, false)).toEqual({
        kind: "stale",
        reason,
      });
    }
    expect(judgeApply(linked, approved(), fresh, true)).toEqual({
      kind: "stale",
      reason: "already_linked",
    });
  });

  test("what the card showed is checked before whether the change is still valid", () => {
    const both = { ...fresh, monitored: channelFacts({ kind: "public", isMember: false }) };
    expect(judgeApply(linked, approved(), both, false)).toEqual({
      kind: "stale",
      reason: "audience_changed",
    });
  });
});
