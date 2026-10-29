// Which app holds each Slack app.
//
// Slack hands each event to just one of a Slack app's Socket Mode connections, so two apps the
// bridge hosts that connect through one Slack app would each silently miss some of what their
// channels say. So each Slack app is held by one app, and Slack confirming its tokens for any other
// refuses them. The first app in start order whose bridge.db records a Slack app holds it, so a
// restart keeps the app that was already answering through it, and a Slack app no bridge.db
// records goes to the first app Slack confirms it for.

/** The app holding each Slack app, by the Slack app's ID. */
export type SlackAppHolders = ReadonlyMap<string, string>;

/**
 * Claims the Slack app with ID `slackAppId` for the app whose tokens Slack confirmed for it, and
 * returns the app that holds it instead, or null when that app does.
 */
export type ClaimSlackApp = (slackAppId: string) => string | null;

/** The Slack app each app's bridge.db records, in start order, each held by the first to record it. */
export function recordedHolders(
  recorded: readonly { app: string; slackAppId: string | null }[],
): SlackAppHolders {
  const holders = new Map<string, string>();
  for (const { app, slackAppId } of recorded) {
    if (slackAppId !== null && !holders.has(slackAppId)) holders.set(slackAppId, app);
  }
  return holders;
}

/**
 * Claims `slackAppId` for `app`, which then holds it unless another app already does. `heldBy`
 * names that app, or is null when `app` holds it.
 */
export function claimSlackApp(
  holders: SlackAppHolders,
  slackAppId: string,
  app: string,
): { holders: SlackAppHolders; heldBy: string | null } {
  const holder = holders.get(slackAppId);
  if (holder === undefined) {
    return { holders: new Map([...holders, [slackAppId, app]]), heldBy: null };
  }
  return { holders, heldBy: holder === app ? null : holder };
}
