// A rare event in Slack pauses a link until the owner resumes it, and wakes the lead once so it can
// tell them. Status says why, and what an allowed person asks while it's paused doesn't reach the
// lead.

import { expect, test } from "bun:test";
import { ALICE, BOT, connectedBridge, posted, said, timestamps } from "./connectedBridge";
import { waitFor } from "./waitFor";

const [changedTs, askedTs] = timestamps(2);

/** The notice Slack posts in C-link when Alice changes the channel. */
const notice = (subtype: string, text: string) =>
  posted(said(ALICE, changedTs, `<@${ALICE}> ${text}`, { subtype }));

test.each([
  {
    cause: "the bot is removed",
    event: {
      type: "member_left_channel",
      user: BOT,
      channel: "C-link",
      channel_type: "G",
      team: "T-home",
      event_ts: changedTs,
    },
    reason: "bot_removed",
  },
  {
    cause: "the channel is archived",
    event: notice("channel_archive", "archived the channel"),
    reason: "channel_archived",
  },
  {
    cause: "the channel is made public",
    event: notice("channel_convert_to_public", "made this channel *public*"),
    reason: "channel_made_public",
  },
  {
    cause: "the channel is shared outside the org",
    event: {
      type: "channel_shared",
      connected_team_id: "T-other",
      channel: "C-link",
      event_ts: changedTs,
    },
    reason: "workspace_joined",
  },
  {
    cause: "Slack gives the channel a new ID",
    event: {
      type: "channel_id_changed",
      old_channel_id: "C-link",
      new_channel_id: "C-moved",
      event_ts: changedTs,
    },
    reason: "channel_id_changed",
  },
])(
  "a link pauses when $cause and wakes the lead once, and what Alice asks then doesn't reach it",
  async ({ event, reason }) => {
    const { channelId, toyBox, status, inbox, deliver, post, stop, saying } =
      await connectedBridge();
    await deliver(event);
    await post(said(ALICE, askedTs, `<@${BOT}> can you check the deploy?`));

    expect(await status(channelId)).toMatchObject({
      json: { links: [{ status: "suspended", statusReason: reason }] },
    });
    expect(await inbox()).toMatchObject({ linkStatus: "suspended", requests: [] });
    await waitFor(() => expect(toyBox.runs).toHaveLength(1), 5_000);
    expect(await stop()).toEqual({ code: 0, stderr: saying() });
    expect(toyBox.runs).toHaveLength(1);
  },
);
