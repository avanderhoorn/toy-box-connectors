// The images the lead shows in Slack. The CLI sends the bytes of each file a post names, and the
// bridge uploads only its pixels, as a file only the bot sees until the post shows it below the
// text, once Slack has processed it. Nothing of them stays in the data folder.

import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";
import { chunk, idat, iend, ihdr, png } from "@files/model/testFixtures";
import type { FakeSlack, FakeSlackMessage } from "../fakes/slack";
import { filesHolding, runToyBoxSlack, withDatabase } from "./bridgeProcess";
import { ALICE, BOT, connectedBridge, said, timestamps } from "./connectedBridge";
import { waitFor } from "./waitFor";

/** What the tool that drew an image wrote in it besides its pixels, which Slack must never get. */
const NOTE = "Drawn on OSPREY-31";

test("reply, post and publish show the images the lead names below the text, in order with their alt text, and keep no copy", async () => {
  const { slack, toyBox, channelId, home, dataFolder, post, inbox, stop, saying } =
    await connectedBridge();
  toyBox.scheduleRoutine(channelId, {
    title: "Release notes",
    schedule: "0 16 * * 5",
    prompt: "Post this week's release notes with `toy-box-slack publish --series notes`.",
  });
  const [askedTs] = timestamps(1);
  await post(said(ALICE, askedTs, `<@${BOT}> did the builds get faster?`));
  await inbox();
  const folder = createTestFolder();
  const [chart, steps] = [drawing(16, 8), drawing(12, 6)];
  writeFileSync(join(folder, "chart.png"), chart.drawn);
  writeFileSync(join(folder, "steps.png"), steps.drawn);
  const lead = { HOME: home, COPILOT_AGENT_SESSION_ID: channelId };
  const showing = (name: string, alt: string) => ["--image", join(folder, name), "--alt", alt];

  expect(
    await runToyBoxSlack(
      [
        "reply",
        "r1",
        ...showing("chart.png", "-5% build time since Monday"),
        ...showing("steps.png", "The three slowest build steps"),
      ],
      lead,
      "They did.\n",
    ),
  ).toEqual({
    exitCode: 0,
    stdout:
      "Queued o1 with 2 images to answer r1 in its thread. If it can't post, inbox shows r1 again.\n",
    stderr: "",
  });
  expect(
    await runToyBoxSlack(
      ["post", "--mention", ALICE, ...showing("steps.png", "The three slowest build steps")],
      lead,
      "Here's where the time goes.\n",
    ),
  ).toEqual({
    exitCode: 0,
    stdout: `Queued o2 with 1 image in #C-link, mentioning ${ALICE}.\n`,
    stderr: "",
  });
  expect(
    await runToyBoxSlack(
      ["publish", "--series", "notes", ...showing("chart.png", "Build times this week")],
      lead,
      "Builds got faster.\n",
    ),
  ).toEqual({
    exitCode: 0,
    stdout: expect.stringMatching(
      /^Queued o3 with 1 image in #C-link for the run of "Release notes" scheduled .+\.\n$/,
    ),
    stderr: "",
  });

  await waitFor(() => expect(posts(slack)).toHaveLength(3), 5_000);
  expect(posts(slack).map((message) => shown(slack, message))).toEqual([
    {
      thread: askedTs,
      blocks: [
        { type: "markdown", text: "They did.\n" },
        { png: chart.pixels, alt: "-5% build time since Monday" },
        { png: steps.pixels, alt: "The three slowest build steps" },
      ],
    },
    {
      blocks: [
        { type: "markdown", text: `<@${ALICE}>\n\nHere's where the time goes.\n` },
        { png: steps.pixels, alt: "The three slowest build steps" },
      ],
    },
    {
      blocks: [
        { type: "markdown", text: "Builds got faster.\n" },
        { png: chart.pixels, alt: "Build times this week" },
      ],
    },
  ]);

  // Slack keeps each image's alt text with its file too, for a screen reader to read there.
  const described = slack.calls
    .filter(({ method }) => method === "files.getUploadURLExternal")
    .map(({ args }) => args.alt_txt);
  expect(described).toEqual([
    "-5% build time since Monday",
    "The three slowest build steps",
    "The three slowest build steps",
    "Build times this week",
  ]);

  expect(await stop()).toEqual({ code: 0, stderr: saying() });
  // Finding the answer shows the search sees what the bridge keeps.
  const holding = (part: string | Uint8Array) => filesHolding(dataFolder, part);
  expect(["They did.", NOTE, chart.drawn.toBase64(), chart.compressed].map(holding)).toEqual([
    [join(dataFolder, "bridge.db")],
    [],
    [],
    [],
  ]);
  await withDatabase(dataFolder, async (database) => {
    expect(await database.read((sql) => sql`SELECT file_id FROM file_deletions`)).toEqual([]);
  });
}, 15_000);

/**
 * A `width` × `height` PNG of noise, which compressing can't shorten, as a drawing tool writes it
 * with a note, and as only its pixels.
 */
function drawing(width: number, height: number) {
  const stride = 1 + width * 3;
  const rows = crypto.getRandomValues(new Uint8Array(stride * height));
  // Each row opens with its filter, none.
  for (let row = 0; row < height; row++) rows[row * stride] = 0;
  const header = ihdr(width, height, 8, 2);
  const pixels = idat(rows);
  return {
    drawn: png(header, chunk("tEXt", Buffer.from(`Comment\0${NOTE}`)), pixels, iend),
    pixels: png(header, pixels, iend),
    /** Bytes from inside the compressed pixels. */
    compressed: pixels.subarray(8, 72),
  };
}

/** The bot's messages in C-link, threads and all, oldest first. */
function posts(slack: FakeSlack): FakeSlackMessage[] {
  return slack.getMessages("C-link").filter((message) => message.user === BOT);
}

/** The thread `message` is in, and its blocks, showing each image as its file's bytes and alt text. */
function shown(slack: FakeSlack, { thread_ts: thread, blocks }: FakeSlackMessage) {
  const shows = (blocks as Record<string, unknown>[]).map((block) => {
    if (block.type !== "image") return block;
    const { slack_file: file, alt_text: alt } = block as {
      slack_file: { id: string };
      alt_text: string;
    };
    return { png: slack.getFileBytes(file.id), alt };
  });
  return { ...(thread && { thread }), blocks: shows };
}
