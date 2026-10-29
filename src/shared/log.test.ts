import { expect, onTestFinished, spyOn, test } from "bun:test";
import { labeledLog, log } from "./log";

function captureStderr() {
  const write = spyOn(process.stderr, "write").mockImplementation(() => true);
  onTestFinished(() => write.mockRestore());
  return () => write.mock.calls.map(([text]) => text);
}

test("writes its parts to stderr as one line", () => {
  const written = captureStderr();
  log("Tried", 3, "times.");
  expect(written()).toEqual(["Tried 3 times.\n"]);
});

test("writes a string as it is, never as a format", () => {
  const written = captureStderr();
  log("Slack said 100%s", "done");
  expect(written()).toEqual(["Slack said 100%s done\n"]);
});

test("shows an error with its stack", () => {
  const written = captureStderr();
  log("Stopped:", new Error("The disk is full."));
  const [line] = written();
  expect(line).toStartWith("Stopped: ");
  expect(line).toContain("error: The disk is full.\n");
  expect(line).toContain(`${import.meta.path}:`);
});

test("a labeled log starts each line with its label", () => {
  const written = captureStderr();
  const releases = labeledLog("releases");
  releases("Connected to Slack.");
  releases("Tried", 3, "times.");
  expect(written()).toEqual(["[releases] Connected to Slack.\n", "[releases] Tried 3 times.\n"]);
});

test("goes on once nothing reads stderr, as console.error does", () => {
  const closed = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  expect(() => process.stderr.emit("error", closed)).not.toThrow();
});
