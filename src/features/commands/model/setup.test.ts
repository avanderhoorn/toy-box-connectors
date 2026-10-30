import { describe, expect, test } from "bun:test";
import { presentDropped, type QueuedPost } from "./setup";

describe("naming the posts a wider audience stopped", () => {
  const reply = (number: number, requestId: number): QueuedPost => ({
    number,
    kind: "reply",
    requestId,
    series: null,
  });
  const publication: QueuedPost = {
    number: 2,
    kind: "publication",
    requestId: null,
    series: "release-notes",
  };

  test("one is named in a sentence, with the request the lead gets back", () => {
    expect(presentDropped([reply(1, 1)], [1], "#eng")).toBe(
      "More people can read #eng than when the lead wrote o1, its answer to r1, so it won't post. The lead gets r1 back to answer again.",
    );
  });

  test("several are listed, with every request the lead gets back", () => {
    expect(presentDropped([reply(1, 1), publication, reply(3, 4)], [1, 4], "#eng")).toBe(
      "More people can read #eng than when the lead wrote these, so they won't post:\n\n- o1, its answer to r1\n- o2, its release-notes publication\n- o3, its answer to r4\n\nThe lead gets r1 and r4 back to answer again.",
    );
  });

  test("a publication, or an answer whose request closed, gives the lead nothing back", () => {
    expect(presentDropped([publication], [], "#eng")).toBe(
      "More people can read #eng than when the lead wrote o2, its release-notes publication, so it won't post.",
    );
    expect(presentDropped([reply(1, 1), publication], [], "#eng")).toBe(
      "More people can read #eng than when the lead wrote these, so they won't post:\n\n- o1, its answer to r1\n- o2, its release-notes publication",
    );
  });
});
