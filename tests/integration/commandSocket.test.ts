// Commands on a running bridge's socket. The bridge works out who's calling from a fake Toy Box's
// catalog, the way it reads the real one, so these follow each caller rule from the call to the
// answer.

import { expect, onTestFinished, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import { openBridgeDatabase } from "@bridge/server/database";
import { createTestFolder } from "@bridge/server/testFixtures";
import type { CallerFacts } from "@commands/model/callers";
import { commandPath, commandRefusalSchema, commandResultSchema } from "@commands/model/protocol";
import { statusResultSchema } from "@commands/model/status";
import { createStoredLink } from "@links/server/testFixtures";
import { startFakeToyBox } from "../fakes/toybox";
import { spawnBridge } from "./bridgeProcess";
import { waitFor } from "./waitFor";

const REQUESTS_ROUTINE = {
  title: "Slack requests",
  schedule: "0 9 * * 1-5",
  prompt: "Run `toy-box-slack inbox` and answer what's waiting.",
};

const answerSchema = z.union([commandResultSchema(statusResultSchema), commandRefusalSchema]);

/** A bridge running for a data folder whose link follows a fake Toy Box channel. */
async function startLinkedBridge() {
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  const channelId = toyBox.addChannel();
  const routine = toyBox.scheduleRoutine(channelId, REQUESTS_ROUTINE);
  const home = createTestFolder();
  const dataFolder = join(home, ".toy-box-slack");
  prepareDataFolder(dataFolder);
  const database = await openBridgeDatabase(join(dataFolder, "bridge.db"));
  try {
    await createStoredLink(database, "link", {
      toybox_channel_id: channelId,
      requests_routine_id: routine.id,
    });
  } finally {
    await database.close();
  }
  const bridge = spawnBridge(home, { TOY_BOX_URL: toyBox.url });
  await bridge.running();
  const socket = join(dataFolder, "bridge.sock");
  const port = Number(new URL(toyBox.url).port);

  /**
   * Calls `status` the way the CLI does for `sessionId`, which runs in the fake Toy Box like
   * every agent, or for the operator at a terminal when it's null.
   */
  async function status(sessionId: string | null, facts: Partial<CallerFacts> = {}) {
    const response = await fetch(`http://localhost${commandPath("status")}`, {
      unix: socket,
      method: "POST",
      body: JSON.stringify({
        caller: { sessionId, toyBoxPort: sessionId && port, channelId: null, ...facts },
        input: {},
      }),
    });
    return { status: response.status, answer: answerSchema.parse(await response.json()) };
  }

  return { toyBox, channelId, bridge, dataFolder, socket, port, status };
}

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
