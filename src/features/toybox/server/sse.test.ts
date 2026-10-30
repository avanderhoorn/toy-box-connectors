import { describe, expect, test } from "bun:test";
import { readServerSentEvents } from "./sse";

const encoder = new TextEncoder();

describe("reading server-sent events", () => {
  test("joins an event split across chunks, even inside a multibyte character", async () => {
    const bytes = encoder.encode('id: 7\ndata: {"text":"👀"}\n\n');
    async function* body() {
      for (const byte of bytes) yield Uint8Array.of(byte);
    }
    expect(await Array.fromAsync(readServerSentEvents(body()))).toEqual(['{"text":"👀"}']);
  });
});
