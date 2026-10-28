import { expect, test } from "bun:test";
import { suspensions } from "./status";

test("each reason reads after 'suspended', and offers resume unless what it names is gone", () => {
  for (const [reason, { because, fix }] of Object.entries(suspensions)) {
    const gone = reason === "toybox_channel_deleted" || reason === "channel_id_changed";
    expect(`Link a is suspended ${because}.`).toMatch(/^Link a is suspended because [^.;]+\.$/);
    expect(fix).toContain(gone ? "`toy-box-slack unlink`" : "`toy-box-slack resume`");
    expect(fix.includes("resume")).toBe(!gone);
  }
});
