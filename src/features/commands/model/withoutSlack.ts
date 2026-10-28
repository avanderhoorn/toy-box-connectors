// Commands while the bridge can't use Slack.
//
// Until Slack first says hello in a run, and whenever it rejects the tokens or the bridge won't
// use them, the bridge serves only the commands that need nothing from Slack, such as status and
// the commands that narrow. Every other command is refused with what's wrong, how to fix it and
// what still runs. A reconnect doesn't count, because the tokens still work and posts wait for it.

import type { SlackConnection } from "./banner";
import type { CallerRole } from "./callers";
import type { CommandContract } from "./contract";
import type { Refusal } from "./protocol";
import type { SlackState } from "./status";
import { joinNames } from "./wording";

/** Whether the bridge can use Slack, which it can from a run's first hello through any reconnect. */
export function isSlackUsable(connection: SlackConnection): boolean {
  return connection === "connected" || connection === "reconnecting";
}

/**
 * Refuses `subject`, such as "`reply`" or "A widening `set`", while the bridge can't use Slack.
 * The refusal says what's wrong and how to fix it, then names the commands `role` may run until
 * then.
 */
export function refuseWithoutSlack(
  subject: string,
  slack: SlackState,
  contracts: Readonly<Record<string, CommandContract>>,
  role: CallerRole,
): Refusal {
  const runnable = Object.entries(contracts).flatMap(([name, contract]) =>
    contract.withoutSlack && !contract.step && contract.roles.includes(role) ? [`\`${name}\``] : [],
  );
  const problem =
    slack.problem ??
    (slack.connection === "connecting"
      ? "It's still connecting to Slack, so try again in a minute."
      : null);
  const message = [
    `${subject} needs Slack, which the bridge can't use right now.`,
    problem,
    runnable.length > 0 ? `Until then it runs only ${joinNames(runnable)}.` : null,
  ];
  return { rule: "slack_unavailable", message: message.filter(Boolean).join(" ") };
}
