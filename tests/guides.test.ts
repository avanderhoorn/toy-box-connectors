import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("AGENTS.md guides", () => {
  test("the root guide links every subsystem guide", async () => {
    const rootGuide = await Bun.file(join(repoRoot, "AGENTS.md")).text();
    const guides = [...new Bun.Glob("{cli,src,tests}/**/AGENTS.md").scanSync(repoRoot)];

    expect(guides.length).toBeGreaterThan(0);
    expect(guides.filter((guide) => !rootGuide.includes(`(${guide})`))).toEqual([]);
  });

  test("every relative link in a guide resolves", async () => {
    const guides = [
      "AGENTS.md",
      ...new Bun.Glob("{cli,src,tests}/**/AGENTS.md").scanSync(repoRoot),
    ];
    const broken: string[] = [];

    for (const guide of guides) {
      const text = await Bun.file(join(repoRoot, guide)).text();
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:|^#/.test(target!)) continue;
        const path = join(repoRoot, dirname(guide), target!.split("#")[0]!);
        if (!existsSync(path)) broken.push(`${guide} -> ${target}`);
      }
    }

    expect(broken).toEqual([]);
  });
});
