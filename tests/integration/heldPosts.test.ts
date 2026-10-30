// What the lead asks the bridge to post while Slack can't take it waits, and the owner hears why.

import { expect, test } from "bun:test";
import { DEFAULT_APP } from "@bridge/model/apps";
import { rejectedTokensProblem } from "@slackapi/model/identity";
import { withDatabase } from "./bridgeProcess";
import { ALICE, BOT, connectedBridge, PROMPTLY, said, timestamps } from "./connectedBridge";
import { waitFor } from "./waitFor";

test("an answer the lead gives while Slack is down posts once the bridge is back on Slack", async () => {
  const { slack, inbox, status, reply, post, stop, saying } = await connectedBridge({
    wakes: { ...PROMPTLY, retry: 200 },
  });
  const [askedTs] = timestamps(1);
  await post(said(ALICE, askedTs, `<@${BOT}> can you check the deploy?`));
  await inbox();

  // Slack drops the connection, and turns the bridge away the first time it reconnects.
  slack.failNext("apps.connections.open", { status: 503 });
  slack.dropConnections();
  await waitFor(async () =>
    expect((await status(null)).json).toMatchObject({ slack: { connection: "reconnecting" } }),
  );
  expect(await reply(1, "The deploy is fine.")).toMatchObject({ exitCode: 0 });

  await waitFor(() => expect(slack.getMessages("C-link")).toHaveLength(2), 5_000);
  // The first connection, the one Slack turned away, and the one it took back all came first.
  const methods = slack.calls.map(({ method }) => method);
  const beforeAnswer = methods.slice(0, methods.indexOf("chat.postMessage"));
  expect(beforeAnswer.filter((method) => method === "apps.connections.open")).toHaveLength(3);
  expect(await stop()).toEqual({
    code: 0,
    stderr: saying(
      "Lost the connection to Slack, so the bridge is reconnecting.",
      "Can't connect to Slack. Slack didn't answer apps.connections.open: HTTP 503.",
      "Connected to Slack.",
    ),
  });
}, 15_000);

test("a bot token Slack rejects mid-post keeps the answer queued, and status and the log name the token to replace", async () => {
  const { slack, dataFolder, inbox, status, reply, post, stop, saying } = await connectedBridge();
  const [askedTs] = timestamps(1);
  await post(said(ALICE, askedTs, `<@${BOT}> can you check the deploy?`));
  await inbox();

  slack.failNext("chat.postMessage", { error: "token_revoked" });
  expect(await reply(1, "The deploy is fine.")).toMatchObject({ exitCode: 0 });
  const problem = rejectedTokensProblem([["SLACK_BOT_TOKEN", "token_revoked"]], DEFAULT_APP);
  await waitFor(async () =>
    expect((await status(null)).json).toMatchObject({
      slack: { connection: "auth_failed", problem },
    }),
  );

  expect(await stop()).toEqual({ code: 0, stderr: saying(problem) });
  expect(slack.getMessages("C-link")).toHaveLength(1);
  await withDatabase(dataFolder, async (database) => {
    expect(await database.read((sql) => sql`SELECT state, error FROM outbox`)).toEqual([
      { state: "queued", error: "token_revoked" },
    ]);
  });
}, 15_000);
