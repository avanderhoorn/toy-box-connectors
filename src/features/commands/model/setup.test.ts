import { describe, expect, test } from "bun:test";
import { presentDropped, type QueuedPost } from "./setup";

describe("naming the posts a wider audience stopped", () => {
  const reply = (number: number, requestId: number): QueuedPost => ({
    number,
    kind: "reply",
    requestId,
    threadTs: `1700000000.00000${requestId}`,
    series: null,
  });
  const publication: QueuedPost = {
    number: 2,
    kind: "publication",
    requestId: null,
    threadTs: null,
    series: "release-notes",
  };

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

  test("a post is named by where it would have gone", () => {
    const post = (number: number, requestId: number | null, threadTs: string | null) =>
      ({ number, kind: "post", requestId, threadTs, series: null }) satisfies QueuedPost;
    const posts = [
      post(4, null, null),
      post(5, 1, "1700000000.000001"),
      post(6, null, "1700000000.000002"),
    ];

    expect(presentDropped(posts, [], "#eng")).toBe(
      "More people can read #eng than when the lead wrote these, so they won't post:\n\n- o4, its post at the top of the channel\n- o5, its post in r1's thread\n- o6, its post in a thread it started",
    );
  });
});
