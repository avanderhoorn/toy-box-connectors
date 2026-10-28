// A running bridge with one link, whose lead leads a channel in a fake Toy Box.

import { onTestFinished } from "bun:test";
import { join } from "node:path";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import { openBridgeDatabase, type BridgeDatabase } from "@bridge/server/database";
import { commandSocketPath } from "@bridge/server/socket";
import { createTestFolder } from "@bridge/server/testFixtures";
import { callBridge } from "@commands/client/cli";
import type { Inbox } from "@commands/model/inbox";
import { createStoredLink } from "@links/server/testFixtures";
import { createStoredRequest } from "@requests/server/testFixtures";
import { startFakeToyBox } from "../fakes/toybox";
import { spawnBridge } from "./bridgeProcess";

/** The routine a lead registers so the bridge can wake it. */
export const REQUESTS_ROUTINE = {
  title: "Slack requests",
  schedule: "0 9 * * 1-5",
  prompt: "Run `toy-box-slack inbox` and answer what's waiting.",
};

const DAY = 24 * 60 * 60_000;

/** Stores a request on the link that arrived just now, so it waits on the lead for a day. */
export function storeNewRequest(database: BridgeDatabase) {
  const at = Date.now();
  return createStoredRequest(database, { createdAt: at, changedAt: at, expiresAt: at + DAY });
}

/** Settings of a stored link, such as its request mode. */
export type LinkColumns = NonNullable<Parameters<typeof createStoredLink>[2]>;

/**
 * A bridge running for a data folder whose link watches C-link for a fake Toy Box channel that has
 * the requests routine, with `env` added to its environment. The link allows the people in
 * `allowed`, and `link` changes its settings. `prepare` changes the database before the bridge
 * opens it. Once the bridge stops, `serve` starts another over the same data folder.
 */
export async function startLinkedBridge({
  env = {},
  link = {},
  allowed = [],
  prepare,
}: {
  env?: Record<string, string>;
  link?: LinkColumns;
  allowed?: readonly string[];
  prepare?: (database: BridgeDatabase) => Promise<unknown>;
} = {}) {
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  const channelId = toyBox.addChannel();
  const routine = toyBox.scheduleRoutine(channelId, REQUESTS_ROUTINE);
  const home = createTestFolder();
  const dataFolder = join(home, ".toy-box-slack");
  prepareDataFolder(dataFolder);
  const database = await openBridgeDatabase(join(dataFolder, "bridge.db"));
  try {
    await createStoredLink(database, "link", { toybox_channel_id: channelId, ...link });
    await database.write(async (transaction) => {
      for (const userId of allowed) {
        await transaction`
          INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', ${userId}, 0)
        `;
      }
    });
    await prepare?.(database);
  } finally {
    await database.close();
  }
  const bridge = await serve(env);

  /** Runs a bridge for the data folder with `added` in its environment, once it says it's running. */
  async function serve(added: Record<string, string>) {
    const started = spawnBridge(home, { TOY_BOX_URL: toyBox.url, ...added });
    await started.running();
    return started;
  }

  /**
   * Calls `name` with `input` the way the CLI does, in session `sessionId`, or at a terminal when
   * it's null.
   */
  function call(
    name: string,
    sessionId: string | null,
    channel: string | null = null,
    input: Record<string, unknown> = {},
  ) {
    const env = { COPILOT_AGENT_SESSION_ID: sessionId ?? undefined };
    return callBridge(name, input, { channelId: channel, env, home });
  }

  return {
    toyBox,
    channelId,
    routine,
    bridge,
    home,
    dataFolder,
    socket: commandSocketPath(dataFolder),
    serve,
    /** Status for `sessionId`, or for the owner at a terminal, of the link --channel names. */
    status: (sessionId: string | null, channel: string | null = null) =>
      call("status", sessionId, channel),
    /** What inbox shows the channel's lead, which marks what it shows read. */
    inbox: async () => (await call("inbox", channelId)).json as Inbox,
    /** Has the channel's lead answer request `id` with `text`. */
    reply: (id: number, text: string) =>
      call("reply", channelId, null, { request: `r${id}`, text }),
  };
}
