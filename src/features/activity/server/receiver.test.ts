import { Database } from "bun:sqlite";
import { expect, onTestFinished, spyOn, test } from "bun:test";
import { join } from "node:path";
import { ACK_DEADLINE_MS } from "@activity/model/receiver";
import { openBridgeDatabase, type BridgeDatabase } from "@bridge/server/database";
import { createTestFolder } from "@bridge/server/testFixtures";
import { createStoredLink } from "@links/server/testFixtures";
import { readFrame } from "@slackapi/model/envelopes";
import { createStoredInstallation } from "@slackapi/server/testFixtures";
import { startSlackReceiver } from "./receiver";

const arrivedAt = 1_700_001_000_000;

/** Our bot U0BOT's authorization, as Slack lists it on an event for our installation. */
const ourBot = {
  enterprise_id: null,
  team_id: "T-home",
  user_id: "U0BOT",
  is_bot: true,
  is_enterprise_install: false,
};

/** What the owner says at the root of C-link at `ts`. */
const said = (ts: string, text = "<@U0BOT> can you check the deploy?") => ({
  type: "message",
  channel: "C-link",
  user: "U-owner",
  team: "T-home",
  text,
  ts,
});

const asked = said("1700000100.000100");
const archived = {
  ...said("1700000200.000100", "archived the channel"),
  subtype: "channel_archive",
};

/**
 * A receiver for the link that watches C-link for the owner, which commits 100 ms after a delivery
 * arrives unless the test moves its clock. `events` records each ack, with what had committed when
 * it was sent, and each callback, in order.
 */
async function openReceiver() {
  const path = join(createTestFolder(), "bridge.db");
  const database = await openBridgeDatabase(path);
  onTestFinished(() => database.close());
  await createStoredInstallation(database, { bot_user_id: "U0BOT" });
  await createStoredLink(database);
  await database.write(
    (transaction) => transaction`
      INSERT INTO allowlist (link_id, user_id, added_at) VALUES ('link', 'U-owner', 0)
    `,
  );
  const committed = new Database(path, { readonly: true });
  onTestFinished(() => committed.close());
  const events: string[] = [];
  let lag = 100;
  const receiver = startSlackReceiver(database, {
    onChange: () => events.push("changed"),
    onUninstalled: () => events.push("uninstalled"),
    onError: (error) => events.push(`stopped on ${(error as Error).message}`),
    now: () => arrivedAt + lag,
  });
  onTestFinished(() => receiver.stop());
  return {
    database,
    receiver,
    events,
    lag: (ms: number) => (lag = ms),
    /** Receives `event` in envelope `id`. */
    receive: (id: string, event: object) =>
      receiver.receive(eventFrame(id, event), arrivedAt, (envelopeId) => {
        const { messages, requests } = committed
          .query(
            `SELECT (SELECT count(*) FROM messages) AS messages,
              (SELECT count(*) FROM requests) AS requests`,
          )
          .get() as { messages: number; requests: number };
        events.push(`acked ${envelopeId} after ${messages} messages and ${requests} requests`);
      }),
  };
}

function eventFrame(id: string, event: object) {
  const frame = readFrame(
    JSON.stringify({
      type: "events_api",
      envelope_id: `env-${id}`,
      payload: {
        type: "event_callback",
        team_id: "T-home",
        api_app_id: "A-app",
        event_id: `Ev-${id}`,
        event_time: 1_700_000_900,
        authorizations: [ourBot],
        event,
      },
    }),
  );
  if (frame.kind !== "event") throw new Error(`Expected an event, not ${frame.kind}.`);
  return frame;
}

function readLinks(database: BridgeDatabase) {
  return database.read((sql) => sql`SELECT status, status_reason FROM links`);
}

test("a delivery is acked once everything it changed has committed, and its redelivery changes nothing", async () => {
  const { receive, events } = await openReceiver();
  await receive("1", asked);
  await receive("2", asked);

  expect(events).toEqual([
    "acked env-1 after 1 messages and 1 requests",
    "changed",
    "acked env-2 after 1 messages and 1 requests",
  ]);
});

test("a delivery stored too late to ack is left for Slack to send again", async () => {
  const { receive, events, lag } = await openReceiver();
  const error = spyOn(console, "error").mockImplementation(() => {});
  lag(ACK_DEADLINE_MS + 1);
  await receive("1", asked);
  lag(100);
  await receive("2", asked);

  expect(events).toEqual(["changed", "acked env-2 after 1 messages and 1 requests"]);
  expect(error).toHaveBeenCalledWith(
    "Stored a delivery from Slack too late to ack it, so Slack will resend it.",
  );
});

test("a delivery that fails to commit isn't acked, and nothing after it is handled", async () => {
  const { database, receiver, receive, events } = await openReceiver();
  spyOn(console, "error").mockImplementation(() => {});
  await receiver.connected(arrivedAt);
  spyOn(database, "write").mockImplementationOnce(() => Promise.reject(new Error("disk full")));
  await receive("1", asked);
  await receive("2", said("1700000300.000100"));
  await receiver.disconnected(arrivedAt + 1);

  expect(events).toEqual(["stopped on disk full"]);
  expect(
    await database.read(
      (sql) => sql`
        SELECT connected_at, disconnected_at, (SELECT count(*) FROM messages) AS messages
        FROM installation
      `,
    ),
  ).toEqual([{ connected_at: arrivedAt, disconnected_at: null, messages: 0 }]);
});

test("redelivering what suspends a channel's links or uninstalls the app changes nothing", async () => {
  const { database, receive, events } = await openReceiver();
  const uninstalled = { type: "app_uninstalled" };
  await receive("1", archived);
  await receive("2", archived);
  expect(await readLinks(database)).toEqual([
    { status: "suspended", status_reason: "channel_archived" },
  ]);
  await receive("3", uninstalled);
  await receive("4", uninstalled);

  expect(events).toEqual([
    "acked env-1 after 1 messages and 0 requests",
    "changed",
    "acked env-2 after 1 messages and 0 requests",
    "acked env-3 after 0 messages and 0 requests",
    "changed",
    "uninstalled",
    "acked env-4 after 0 messages and 0 requests",
  ]);
  expect(await readLinks(database)).toEqual([]);
});
