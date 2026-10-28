import { expect, onTestFinished, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestFolder } from "@bridge/server/testFixtures";

const CLI = join(import.meta.dir, "..", "..", "cli", "index.ts");

test("ignores a .env file in the folder it runs from", async () => {
  const home = createTestFolder();
  const project = createTestFolder();
  writeFileSync(join(project, ".env"), "TOY_BOX_URL=http://toy-box.example.com:3000\n");

  // Run through the file's own shebang, the way a shell or launchd runs the installed CLI, with
  // the Bun running these tests first on PATH.
  const bin = createTestFolder();
  symlinkSync(process.execPath, join(bin, "bun"));
  const child = Bun.spawn([CLI, "serve"], {
    cwd: project,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  onTestFinished(() => child.kill("SIGKILL"));

  const decoder = new TextDecoder();
  let stderr = "";
  for await (const chunk of child.stderr) {
    stderr += decoder.decode(chunk, { stream: true });
    if (stderr.includes("toy-box-slack is running")) break;
  }
  child.kill("SIGTERM");

  expect(stderr).toBe(`toy-box-slack is running for ${join(home, ".toy-box-slack")}\n`);
  expect(await child.exited).toBe(0);
}, 15_000);
