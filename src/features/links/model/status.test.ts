import { describe, expect, test } from "bun:test";
import { suspensions, type SuspendReason } from "./status";

/** The reasons resuming can't end, because the link names something that's gone. */
const unresumable: SuspendReason[] = ["toybox_channel_deleted", "channel_id_changed"];

describe("why a link is suspended", () => {
  test("each reason reads after 'suspended' and ends in the command that ends it", () => {
    for (const [reason, { because, fix }] of Object.entries(suspensions)) {
      expect(`Link a is suspended ${because}.`).toMatch(/^Link a is suspended because [^.;]+\.$/);
      expect(fix).toMatch(/^[A-Z][^;]*\.$/);
      expect(fix).toContain(
        unresumable.includes(reason as SuspendReason)
          ? "`toy-box-slack unlink`"
          : "`toy-box-slack resume`",
      );
    }
  });

  test("a link that names something gone is never offered resume", () => {
    for (const reason of unresumable) expect(suspensions[reason].fix).not.toContain("resume");
  });
});
