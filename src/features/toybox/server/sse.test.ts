import { describe, expect, test } from "bun:test";
import { readServerSentEvents } from "./sse";

const encoder = new TextEncoder();

async function read(...chunks: string[]): Promise<string[]> {
  async function* body() {
    for (const chunk of chunks) yield encoder.encode(chunk);
  }
  return Array.fromAsync(readServerSentEvents(body()));
}

describe("reading server-sent events", () => {
  test("reads Toy Box's framing, skipping its retry hint and keepalive comments", async () => {
    expect(
      await read(
        "retry: 1000\n\n",
        'id: 4\ndata: {"type":"snapshot"}\n\n',
        ": keepalive\n\n",
        'data: {"type":"presence"}\n\n',
      ),
    ).toEqual(['{"type":"snapshot"}', '{"type":"presence"}']);
  });

  test("joins an event split across chunks, even inside a multibyte character", async () => {
    const bytes = encoder.encode('id: 7\ndata: {"text":"👀"}\n\n');
    async function* body() {
      for (const byte of bytes) yield Uint8Array.of(byte);
    }
    expect(await Array.fromAsync(readServerSentEvents(body()))).toEqual(['{"text":"👀"}']);
  });

  test("accepts CRLF and CR line breaks, including a CRLF split between chunks", async () => {
    expect(await read("data: a\r", "\n\r\n", "data: b\r\r")).toEqual(["a", "b"]);
  });

  test("joins data lines with line feeds and strips one space after the colon", async () => {
    expect(await read("data:one\ndata:  two\ndata\n\n")).toEqual(["one\n two\n"]);
  });

  test("ignores fields it doesn't read", async () => {
    expect(await read("id: 1\nevent: update\ndata: a\n\n")).toEqual(["a"]);
  });

  test("never dispatches an event the stream ends inside", async () => {
    expect(await read("data: a\n\ndata: b\n")).toEqual(["a"]);
  });
});
