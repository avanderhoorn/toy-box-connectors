import { expect, test } from "bun:test";
import { renderCard } from "@links/model/cards";
import { pendingApproval } from "@links/model/testFixtures";
import { checkCardPayload, checkCardUpdatePayload, checkLeadPayload } from "./payload";
import { renderMarkdown } from "./rendering";

function message(markdown = "A safe **answer** with [docs](https://example.com/a?a=1&b=2).") {
  const result = renderMarkdown(markdown);
  expect(result.kind).toBe("rendered");
  if (result.kind !== "rendered") throw new Error("The test needs rendered text.");
  return result.message;
}

test("a stored renderer result survives JSON exactly, with no second render", () => {
  const original = message();
  const stored: unknown = JSON.parse(JSON.stringify(original));

  expect(checkLeadPayload(stored)).toEqual({ kind: "valid", message: original });
  expect(JSON.stringify(checkLeadPayload(stored))).toContain(JSON.stringify(original));
});

test.each([
  { parse: "full" },
  { mrkdwn: true },
  { unfurl_links: true },
  { unfurl_media: true },
  { link_names: true },
  { metadata: { event_type: "toy_box_outbox", event_payload: {} } },
  { blocks: [{ type: "section", text: { type: "mrkdwn", text: "Hello" } }] },
  { blocks: [{ type: "header", text: { type: "plain_text", text: "Raw blocks" } }] },
])("an unsafe or unrendered snapshot is refused: %j", (change) => {
  expect(checkLeadPayload({ ...message(), ...change })).toEqual({
    kind: "refused",
    problem: "invalid_snapshot",
  });
});

test("the stored fallback and section text are checked for secret shapes", () => {
  const original = message();
  for (const changed of [
    { ...original, text: "xoxb-test-secret-never-send" },
    {
      ...original,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "xoxb-test-secret-never-send", verbatim: true },
        },
      ],
    },
  ]) {
    expect(checkLeadPayload(changed)).toEqual({ kind: "refused", problem: "slack_token" });
  }
});

test("private links and explicit controls cannot enter a stored lead payload", () => {
  for (const text of ["<http://localhost:3000|Local>", "<@UFAKE>", "<!channel>"]) {
    const original = message();
    original.blocks[0]!.text.text = text;
    expect(checkLeadPayload(original).kind).toBe("refused");
  }
  expect(
    checkLeadPayload(message("Use `http://localhost:3000` and `<@UFAKE>` as literal examples."))
      .kind,
  ).toBe("valid");
  expect(checkLeadPayload({ ...message(), text: "<!channel>" })).toEqual({
    kind: "refused",
    problem: "invalid_snapshot",
  });
});

test("12,000 section characters fit and 12,001 do not", () => {
  const original = message();
  original.blocks = Array.from({ length: 4 }, () => ({
    type: "section",
    text: { type: "mrkdwn", text: "a".repeat(3_000), verbatim: true },
  }));
  expect(checkLeadPayload(original).kind).toBe("valid");
  original.blocks.push({ type: "section", text: { type: "mrkdwn", text: "a", verbatim: true } });
  expect(checkLeadPayload(original)).toEqual({ kind: "refused", problem: "message_too_long" });
});

function cardUpdate() {
  const { text, blocks, parse } = renderCard(
    pendingApproval({ state: "approved", decidedBy: "U-owner", decidedAt: 1 }),
    {},
  );
  return { text, blocks, parse, ts: "1.1" };
}

test("card posts preserve trusted controls but edits snapshot only their actual arguments", () => {
  const post = renderCard(pendingApproval(), {});
  expect(checkCardPayload(post)).toEqual({ kind: "valid", message: post });
  const update = cardUpdate();
  expect(checkCardUpdatePayload(update)).toEqual({ kind: "valid", message: update });
});

test("an edit cannot restore pending approval buttons", () => {
  const pending = renderCard(pendingApproval(), {});
  expect(
    checkCardUpdatePayload({
      text: pending.text,
      blocks: pending.blocks,
      parse: pending.parse,
      ts: "1.1",
    }),
  ).toEqual({ kind: "refused", problem: "invalid_snapshot" });
});

test.each([
  { ts: null },
  { ts: undefined },
  { ts: "not-a-ts" },
  { parse: "full" },
  { unfurl_links: false },
  { unfurl_media: false },
  { metadata: {} },
])("an edit snapshot refuses missing proof or unsupported arguments: %j", (change) => {
  expect(checkCardUpdatePayload({ ...cardUpdate(), ...change })).toEqual({
    kind: "refused",
    problem: "invalid_snapshot",
  });
});
