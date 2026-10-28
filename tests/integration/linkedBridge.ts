// A running bridge with one link, which follows a channel in a fake Toy Box.

import { onTestFinished } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import { openBridgeDatabase, type BridgeDatabase } from "@bridge/server/database";
import { commandSocketPath } from "@bridge/server/socket";
import { createTestFolder } from "@bridge/server/testFixtures";
import type { CallerFacts } from "@commands/model/callers";
import { inboxResultSchema } from "@commands/model/inbox";
import { commandPath, commandRefusalSchema, commandResultSchema } from "@commands/model/protocol";
import { statusResultSchema } from "@commands/model/status";
import { createStoredLink } from "@links/server/testFixtures";
import { routineTemplates } from "@toybox/model/routines";
import { startFakeToyBox } from "../fakes/toybox";
import { spawnBridge } from "./bridgeProcess";

const answerSchema = z.union([commandResultSchema(statusResultSchema), commandRefusalSchema]);

/** Settings of a stored link, such as its request mode. */
export type LinkColumns = NonNullable<Parameters<typeof createStoredLink>[2]>;

/**
 * A bridge running for a data folder whose link follows a fake Toy Box channel and watches C-link,
 * with `env` added to its environment. The channel's requests routine is the template. The link
 * allows the people in `allowed`, and `link` changes its settings. `prepare` changes the data
 * folder and its database before the bridge opens them.
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
  prepare?: (database: BridgeDatabase, dataFolder: string) => Promise<unknown>;
} = {}) {
  const toyBox = startFakeToyBox();
  onTestFinished(() => toyBox.stop());
  const channelId = toyBox.addChannel();
  const routine = toyBox.scheduleRoutine(channelId, routineTemplates.requests);
  const home = createTestFolder();
  const dataFolder = join(home, ".toy-box-slack");
  prepareDataFolder(dataFolder);
  const database = await openBridgeDatabase(join(dataFolder, "bridge.db"));
  try {
    await createStoredLink(database, "link", {
      toybox_channel_id: channelId,
      requests_routine_id: routine.id,
      ...link,
    });
    await database.write(async (transaction) => {
      for (const userId of allowed) {
        await transaction`
          INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', ${userId}, 0)
        `;
      }
    });
    await prepare?.(database, dataFolder);
  } finally {
    await database.close();
  }
  const bridge = spawnBridge(home, { TOY_BOX_URL: toyBox.url, ...env });
  await bridge.running();
  const socket = commandSocketPath(dataFolder);
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

  /** Calls `inbox` the way the CLI does for the channel's lead, which reads what it shows. */
  async function inbox() {
    const response = await fetch(`http://localhost${commandPath("inbox")}`, {
      unix: socket,
      method: "POST",
      body: JSON.stringify({
        caller: { sessionId: channelId, toyBoxPort: port, channelId: null },
        input: {},
      }),
    });
    return commandResultSchema(inboxResultSchema).parse(await response.json()).result;
  }

  return { toyBox, channelId, routine, bridge, home, dataFolder, socket, port, status, inbox };
}
