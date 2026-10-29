import { Database } from "bun:sqlite";
import { expect, onTestFinished, spyOn, test } from "bun:test";
import { join } from "node:path";
import { ACK_DEADLINE_MS } from "@activity/model/receiver";
import { openBridgeDatabase } from "@bridge/server/database";
import { captureLog, createTestFolder } from "@bridge/server/testFixtures";
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

/** The owner asking our bot at the root of C-link. */
const asked = {
  type: "message",
  channel: "C-link",
  user: "U-owner",
  team: "T-home",
  text: "<@U0BOT> can you check the deploy?",
  ts: "1700000100.000100",
};

/**
 * A receiver for the owner's link on C-link, committing 100 ms after a delivery arrives unless the
 * test moves its clock. `events` records each callback, and each ack with what had committed.
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
    onMissed: () => events.push("missed"),
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

test("a delivery is acked once everything it changed has committed, and one that fails to commit stops the receiver unacked", async () => {
  const { database, receive, events } = await openReceiver();
  captureLog();
  await receive("1", asked);
  spyOn(database, "write").mockImplementationOnce(() => Promise.reject(new Error("disk full")));
  await receive("2", { ...asked, ts: "1700000200.000100" });
  await receive("3", asked);

  expect(events).toEqual([
    "acked env-1 after 1 messages and 1 requests",
    "changed",
    "stopped on disk full",
  ]);
});

test("a delivery stored too late to ack is left for Slack to send again, which changes nothing", async () => {
  const { receive, events, lag } = await openReceiver();
  const logged = captureLog();
  lag(ACK_DEADLINE_MS + 1);
  await receive("1", asked);
  lag(100);
  await receive("2", asked);

  expect(events).toEqual(["changed", "acked env-2 after 1 messages and 1 requests"]);
  expect(logged()).toContain(
    "Stored a delivery from Slack too late to ack it, so Slack will resend it.",
  );
});

test("each hello, a minute Slack held back and what can't be read note a gap to catch up on", async () => {
  const { database, receiver, receive, events } = await openReceiver();
  captureLog();
  await receiver.connected(arrivedAt - 60_000);
  await receiver.connected(arrivedAt);
  await receiver.receive({ kind: "rate_limited", envelopeId: null }, arrivedAt, () => {});
  await receiver.receive({ kind: "malformed", envelopeId: null, issues: [] }, arrivedAt, () => {});
  await receive("1", { ...asked, ts: 1_700_000_100 });

  expect(await database.read((sql) => sql`SELECT starts_at, ends_at FROM gaps`)).toEqual([
    { starts_at: 0, ends_at: arrivedAt - 60_000 },
    { starts_at: arrivedAt - 60_000, ends_at: arrivedAt },
    { starts_at: arrivedAt + 100, ends_at: arrivedAt + 60_100 },
    { starts_at: arrivedAt + 100, ends_at: arrivedAt + 100 },
    { starts_at: arrivedAt + 100, ends_at: arrivedAt + 100 },
  ]);
  const acked = "acked env-1 after 0 messages and 0 requests";
  expect(events).toEqual(["missed", "missed", "missed", "missed", acked, "missed"]);
});
