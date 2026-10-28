// An end-to-end suite.
//
// A suite runs only with TOY_BOX_SLACK_E2E=1, because it starts real leads that spend model
// credits. Its scenarios share one isolated Toy Box, which starts before the first and stops after
// the last whether they pass or not. A scenario drives real model turns, so it gets one rerun, and
// its timeout outlasts the harness's deadlines, so a failure names what it waited for.

import { afterAll, beforeAll, describe, test } from "bun:test";
import {
  startIsolatedToyBox,
  STARTUP_TIMEOUT,
  STOP_TIMEOUT,
  type IsolatedToyBox,
} from "./isolatedToyBox";
import { TURN_TIMEOUT } from "./testChannel";

export type EndToEndSuite = {
  /** The suite's Toy Box, once it has started. */
  readonly toyBox: IsolatedToyBox;
  /** A test that wakes the lead for `turns` turns. */
  scenario(name: string, run: () => Promise<void>, options: { turns: number }): void;
};

/** Describes a suite that runs only with TOY_BOX_SLACK_E2E=1, around one isolated Toy Box. */
export function describeEndToEnd(name: string, define: (suite: EndToEndSuite) => void) {
  describe.skipIf(process.env.TOY_BOX_SLACK_E2E !== "1")(name, () => {
    let started: IsolatedToyBox | undefined;
    beforeAll(
      async () => {
        started = await startIsolatedToyBox();
      },
      STARTUP_TIMEOUT + STOP_TIMEOUT + 5_000,
    );

    define({
      get toyBox() {
        if (!started) throw new Error("The suite's Toy Box didn't start.");
        return started;
      },
      scenario(name, run, { turns }) {
        test(
          name,
          async () => {
            try {
              await run();
            } catch (error) {
              throw started?.failure(error) ?? error;
            }
          },
          { timeout: turns * TURN_TIMEOUT + 60_000, retry: 1 },
        );
      },
    });
    // Bun runs afterAll hooks in the order they're added, so what the suite started against Toy Box
    // stops before it does.
    afterAll(() => started?.stop(), STOP_TIMEOUT + 5_000);
  });
}
