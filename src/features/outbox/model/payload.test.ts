import { expect, test } from "bun:test";
import { checkLeadPayload } from "./payload";

const flags = { mrkdwn: false, parse: "none", unfurl_links: false, unfurl_media: false } as const;

function asked(text = "Shipped **1.2**.", mentions: string[] = [], images: { alt: string }[] = []) {
  return { text, mentions, images };
}

test("a post goes out as its text renders when it's sent, its block opening with whom it mentions", () => {
  expect(checkLeadPayload(asked("Shipped **1.2**.", ["U0ALICE", "W0BOB"]))).toEqual({
    kind: "valid",
    message: {
      text: "Shipped **1.2**.",
      blocks: [{ type: "markdown", text: "<@U0ALICE> <@W0BOB>\n\nShipped **1.2**." }],
      ...flags,
    },
    mentions: ["U0ALICE", "W0BOB"],
  });
});

test("text that names people or the channel itself goes out escaped, notifying no one", () => {
  const text = "Ask &lt;@W0BOB> or &lt;!here>, not @\u200bchannel.";
  expect(checkLeadPayload(asked("Ask <@W0BOB> or <!here>, not @channel."))).toEqual({
    kind: "valid",
    message: { text, blocks: [{ type: "markdown", text }], ...flags },
    mentions: [],
  });
});

test("a stored payload holds only what the lead asked for, never a control, a block or a render", () => {
  for (const payload of [
    { ...asked(), parse: "full" },
    { ...asked(), unfurl_links: true },
    { ...asked(), link_names: true },
    { ...asked(), metadata: {} },
    { ...asked(), blocks: [{ type: "markdown", text: "<!channel>" }] },
    { ...asked(), mentions: [7] },
    { text: "Shipped.", images: [] },
    { text: "Shipped.", mentions: [] },
    { text: "Shipped.", blocks: [{ type: "markdown", text: "Shipped." }], ...flags },
  ])
    expect(checkLeadPayload(payload)).toEqual({ kind: "refused", problem: "invalid_payload" });
});

test("a stored payload is refused at send for what would have refused it in the queue", () => {
  expect(checkLeadPayload(asked(`Token xoxb-${"a".repeat(32)}`))).toEqual({
    kind: "refused",
    problem: "slack_token",
  });
  expect(checkLeadPayload(asked(" \n"))).toEqual({ kind: "refused", problem: "empty" });
});

test("a post shows its images below its text, in order, each headed by its alt text", () => {
  const image = (file: string, alt: string) =>
    ({
      type: "image",
      slack_file: { id: file },
      alt_text: alt,
      title: { type: "plain_text", text: alt },
    }) as const;
  const charts = [{ alt: "Build minutes per day" }, { alt: "Queue minutes per day" }];
  expect(checkLeadPayload(asked("The chart.", ["U0ALICE"], charts), ["F1", "F2"])).toEqual({
    kind: "valid",
    message: {
      text: "The chart.",
      blocks: [
        { type: "markdown", text: "<@U0ALICE>\n\nThe chart." },
        image("F1", "Build minutes per day"),
        image("F2", "Queue minutes per day"),
      ],
      ...flags,
    },
    mentions: ["U0ALICE"],
  });
});

test("a post's images match its files, and their alt text passes the text's secret check", () => {
  const shown = (...alts: string[]) =>
    asked(
      "The chart.",
      [],
      alts.map((alt) => ({ alt })),
    );
  for (const [payload, files] of [
    [shown("A chart"), []],
    [shown(), ["F1"]],
    [shown("A chart"), ["F1", "F2"]],
    [shown("A", "B", "C", "D"), ["F1", "F2", "F3", "F4"]],
    [shown(""), ["F1"]],
    [shown("a".repeat(1001)), ["F1"]],
    [{ ...shown(), images: [{ alt: "A chart", file: "F2" }] }, ["F1"]],
  ] as const)
    expect(checkLeadPayload(payload, files)).toEqual({
      kind: "refused",
      problem: "invalid_payload",
    });
  expect(checkLeadPayload(shown("a".repeat(1000)), ["F1"]).kind).toBe("valid");
  expect(checkLeadPayload(shown("A chart", `Token xoxb-${"a".repeat(32)}`), ["F1", "F2"])).toEqual({
    kind: "refused",
    problem: "slack_token",
    image: 2,
  });
});
