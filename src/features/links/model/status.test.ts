import { expect, test } from "bun:test";
import { suspensions } from "./status";

test("each reason reads after 'suspended', and offers resume for the link's channel unless what it names is gone", () => {
  for (const [reason, { because, fix }] of Object.entries(suspensions)) {
    const gone = reason === "channel_id_changed";
    expect(`Link a is suspended ${because}.`).toMatch(/^Link a is suspended because [^.;]+\.$/);
    expect(fix("toybox-a")).toContain(
      gone
        ? "`toy-box-slack unlink --channel toybox-a`"
        : "`toy-box-slack resume --channel toybox-a`",
    );
    expect(fix("toybox-a").includes("resume")).toBe(!gone);
  }
});
