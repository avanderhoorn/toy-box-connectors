// The status command.
//
// Status reads the same links as the banner, and adds what only the running bridge knows: whether
// it follows each linked channel's Toy Box stream, and what it last decided about waking the lead.

import type { BridgeDatabase } from "@bridge/server/database";
import type { CommandHandler } from "@commands/model/contract";
import type { SlackState, statusContract } from "@commands/model/status";
import type { ToyBoxClient } from "@toybox/server";
import type { WakeScheduler } from "@wakes/server";
import { readLinksInView } from "./banner";

export type StatusCommandOptions = {
  database: BridgeDatabase;
  /** The Toy Box the bridge serves. */
  origin: URL;
  slack: () => SlackState;
  toyBox: Pick<ToyBoxClient, "view">;
  wakes: Pick<WakeScheduler, "decision">;
};

/** Status for the caller's channel, or for every link when the operator names no channel. */
export function statusCommand({
  database,
  origin,
  slack,
  toyBox,
  wakes,
}: StatusCommandOptions): CommandHandler<typeof statusContract> {
  return async (_input, { caller }) => {
    const links = await database.read((sql) => readLinksInView(sql, caller.channelId));
    return {
      slack: slack(),
      toyBox: origin.origin,
      channelId: caller.channelId,
      links: links.map((link) => ({
        ...link,
        following: toyBox.view(link.toyBoxChannelId).connected,
        wake: wakes.decision(link.id),
      })),
    };
  };
}
