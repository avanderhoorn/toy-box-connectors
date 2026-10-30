// Retention.
//
// The bridge keeps what was said in Slack, or posted there, for 30 days after it last changed, and
// a person's name only while a link allows them. Each feature forgets its own, and the bridge runs
// them together when it starts and hourly after. Only what posting once needs stays longer, and it
// says nothing: a request that hasn't finished, or whose thread holds a post that may still go out
// or that Slack never confirmed, and a post's row, which keeps its request or publication slot
// reserved. The one exception is a post that may still go out, which keeps what it says. Numbers
// keep counting regardless, since SQLite's own tables remember them.

import { forgetOldActivity } from "@activity/server/ledger";
import { forgetOldPosts } from "@outbox/server/database";
import { forgetFinishedRequests } from "@requests/server/database";
import { forgetUnallowedPeople } from "@slackapi/server/users";
import { log as bridgeLog, type Log } from "@/shared/log";
import type { BridgeDatabase } from "./database";

/** Forgets everything the bridge no longer keeps at `now`. */
export async function applyRetention(transaction: Bun.SQL, now: number): Promise<void> {
  // The ledger goes first, so a request whose last message it forgets goes in the same pass.
  await forgetOldActivity(transaction, now);
  await forgetFinishedRequests(transaction);
  await forgetOldPosts(transaction, now);
  await forgetUnallowedPeople(transaction);
}

/**
 * Applies retention now and then hourly, until the timer it returns is cleared, saying in `log` why
 * a later pass failed.
 */
export async function startRetention(
  database: BridgeDatabase,
  onError: (error: unknown) => void,
  log: Log = bridgeLog,
): Promise<Timer> {
  const apply = () => database.write((transaction) => applyRetention(transaction, Date.now()));
  await apply();
  return setInterval(() => {
    apply().catch((error: unknown) => {
      log("Couldn't forget what the bridge no longer keeps:", error);
      onError(error);
    });
  }, 60 * 60_000);
}
