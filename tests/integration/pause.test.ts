// A rare event in Slack suspends a link until the owner resumes or unlinks it, and wakes the lead
// once so it can tell them. Status says why, and what an allowed person asks while it's suspended
// doesn't reach the lead.

import { expect, test } from "bun:test";
import { ALICE, BOT, connectedBridge, posted, said, timestamps } from "./connectedBridge";
import { waitFor } from "./waitFor";

const [changedTs, askedTs] = timestamps(2);

/** The notice Slack posts in C-link when Alice changes the channel. */
const notice = (subtype: string, text: string) =>
  posted(said(ALICE, changedTs, `<@${ALICE}> ${text}`, { subtype }));

test("when the channel is made public, the bridge suspends the link and wakes the lead once, and what Alice asks then doesn't reach it", async () => {
  const { channelId, toyBox, status, inbox, deliver, post, stop, saying } = await connectedBridge();
  await deliver(notice("channel_convert_to_public", "made this channel *public*"));
  await post(said(ALICE, askedTs, `<@${BOT}> can you check the deploy?`));

  expect(await status(channelId)).toMatchObject({
    json: { links: [{ status: "suspended", statusReason: "channel_made_public" }] },
  });
  expect(await inbox()).toMatchObject({ linkStatus: "suspended", requests: [] });
  await waitFor(() => expect(toyBox.runs).toHaveLength(1));
  expect(await stop()).toEqual({ code: 0, stderr: saying() });
  expect(toyBox.runs).toHaveLength(1);
});
