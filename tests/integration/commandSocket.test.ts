// Commands on a running bridge's socket. The bridge works out who's calling from a fake Toy Box's
// catalog, the way it reads the real one, so these follow each caller rule from the call to the
// answer.

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { startLinkedBridge } from "./linkedBridge";
import { waitFor } from "./waitFor";

test("answers the channel's lead with its link, once the bridge follows the channel", async () => {
  const { channelId, status } = await startLinkedBridge();

  await waitFor(async () =>
    expect(await status(channelId)).toMatchObject({
      status: 200,
      answer: {
        banner: { slack: "unconfigured", coverage: "complete", restore: null },
        result: { channelId, links: [{ id: "link", toyBoxChannelId: channelId, following: true }] },
      },
    }),
  );
});

test("answers a member with its channel's link", async () => {
  const { toyBox, channelId, status } = await startLinkedBridge();
  const memberId = toyBox.addMember(channelId, "Reviewer");

  expect(await status(memberId)).toMatchObject({
    status: 200,
    answer: { result: { channelId, links: [{ id: "link" }] } },
  });
});

test("answers the operator with every link", async () => {
  const { status } = await startLinkedBridge();

  expect(await status(null)).toMatchObject({
    status: 200,
    answer: { result: { channelId: null, links: [{ id: "link" }] } },
  });
});

test("refuses a session missing from Toy Box's catalog once it has read the catalog again", async () => {
  const { toyBox, channelId, status } = await startLinkedBridge();
  await status(channelId);
  const reads = toyBox.catalogReads;

  expect(await status("session-elsewhere")).toEqual({
    status: 403,
    answer: {
      version: 1,
      at: expect.any(Number),
      banner: null,
      refused: {
        rule: "unknown_session",
        message: `Session session-elsewhere isn't the lead or a member of a channel in the Toy Box at ${toyBox.url}, so the bridge won't act for it.`,
      },
    },
  });
  expect(toyBox.catalogReads).toBe(reads + 1);
});

test("refuses a member once Toy Box removes them from the channel", async () => {
  const { toyBox, channelId, status } = await startLinkedBridge();
  const memberId = toyBox.addMember(channelId, "Reviewer");
  expect((await status(memberId)).status).toBe(200);

  toyBox.removeMember(memberId);

  await waitFor(async () =>
    expect(await status(memberId)).toMatchObject({
      status: 403,
      answer: { refused: { rule: "unknown_session" } },
    }),
  );
});

test("refuses a caller running in another Toy Box", async () => {
  const { channelId, port, status } = await startLinkedBridge();

  expect(await status(channelId, { toyBoxPort: port - 1 })).toMatchObject({
    status: 403,
    answer: { banner: null, refused: { rule: "toy_box_port" } },
  });
});

test("refuses a session it can't look up while Toy Box is down", async () => {
  const { toyBox, channelId, status } = await startLinkedBridge();
  await toyBox.stop();

  expect(await status(channelId)).toMatchObject({
    status: 503,
    answer: { banner: null, refused: { rule: "toy_box_unreachable" } },
  });
});

test("stops taking calls and removes its socket on SIGTERM", async () => {
  const { bridge, dataFolder, socket, status } = await startLinkedBridge();
  expect((await status(null)).status).toBe(200);

  bridge.child.kill("SIGTERM");

  expect(await bridge.exit()).toEqual({
    code: 0,
    stderr: `toy-box-slack is running for ${dataFolder}\ntoy-box-slack is stopping after SIGTERM\n`,
  });
  expect(existsSync(socket)).toBe(false);
});
