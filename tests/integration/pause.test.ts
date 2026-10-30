// A rare event in Slack suspends a link until the owner resumes or unlinks it, and wakes the lead
// once so it can tell them. Status says why, and what an allowed person asks while it's suspended
// doesn't reach the lead. What the lead wrote before more people could read the channel never
// posts there, and resuming gives the lead back what it answered, to answer again.

import { expect, test } from "bun:test";
import { callBridge } from "@commands/client/cli";
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

test("an answer held when the channel is made public never posts there, and once the owner resumes, the lead answers again", async () => {
  const { channelId, home, slack, toyBox, status, inbox, reply, post, stop, saying } =
    await connectedBridge();
  await post(said(ALICE, askedTs, `<@${BOT}> can you check the deploy?`));
  await inbox();

  // Slack doesn't tell the bridge, which finds out as it posts the answer.
  slack.addChannel({ id: "C-link", is_private: false });
  expect(await reply(1, "Only you can see this: the deploy is fine.")).toMatchObject({
    exitCode: 0,
  });
  await waitFor(async () =>
    expect(await status(channelId)).toMatchObject({
      json: { links: [{ status: "suspended", statusReason: "channel_made_public" }] },
    }),
  );
  await waitFor(() => expect(toyBox.runs).toHaveLength(1));
  const resumed = await callBridge("resume", {}, { channelId, env: {}, home });

  expect(resumed).toMatchObject({ exitCode: 0, json: { dropped: ["o1"] } });
  expect(resumed.text).toEndWith(
    "More people can read #release-eng than when the lead wrote o1, its answer to r1, so it won't post. The lead gets r1 back to answer again.",
  );
  await waitFor(() => expect(toyBox.runs).toHaveLength(2));
  expect(await inbox()).toMatchObject({ requests: [{ id: 1, attention: "reply_failed" }] });
  expect(await reply(1, "The deploy is fine.")).toMatchObject({ exitCode: 0 });
  await waitFor(() =>
    expect(slack.getMessages("C-link").map(({ text }) => text)).toEqual([
      `<@${BOT}> can you check the deploy?`,
      "The deploy is fine.",
    ]),
  );
  expect(await stop()).toEqual({ code: 0, stderr: saying() });
}, 15_000);
