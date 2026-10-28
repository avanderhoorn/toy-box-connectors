import { expect, test } from "bun:test";
import { parseLoopbackUrl } from "./loopback";

test("accepts http on localhost, 127.0.0.0/8 and [::1]", () => {
  for (const value of [
    "http://127.0.0.1:3000",
    "http://localhost:3100/",
    "http://LOCALHOST:3100",
    "http://[::1]:3000",
    "http://127.10.20.30:8080",
    "http://127.1:3000",
  ]) {
    expect(parseLoopbackUrl(value)?.protocol).toBe("http:");
  }
});

test("refuses every other host, scheme and credential", () => {
  for (const value of [
    "",
    "127.0.0.1:3000",
    "https://127.0.0.1:3000",
    "ws://127.0.0.1:3000",
    "http://0.0.0.0:3000",
    "http://10.0.0.1:3000",
    "http://example.com",
    "http://127.0.0.1.example.com",
    "http://localhost.example.com",
    "http://[::ffff:127.0.0.1]:3000",
    "http://user:secret@127.0.0.1:3000",
  ]) {
    expect(parseLoopbackUrl(value)).toBeUndefined();
  }
});
