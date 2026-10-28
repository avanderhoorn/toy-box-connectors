import { describe, expect, test } from "bun:test";
import { suspensions } from "./status";

describe("why a link is suspended", () => {
  test("each reason reads after 'suspended' and ends in the command that ends it", () => {
    for (const [reason, { because, fix }] of Object.entries(suspensions)) {
      expect(`Link a is suspended ${because}.`).toMatch(/^Link a is suspended because [^.;]+\.$/);
      expect(fix).toMatch(/^[A-Z][^;]*\.$/);
      expect(fix).toContain(
        reason === "toybox_channel_deleted" ? "`toy-box-slack unlink`" : "`toy-box-slack resume`",
      );
    }
  });

  test("a link whose Toy Box channel was deleted is never offered resume", () => {
    expect(suspensions.toybox_channel_deleted.fix).not.toContain("resume");
  });
});
