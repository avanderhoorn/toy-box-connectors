import { expect, test } from "bun:test";
import { commands, inputProblem, MAX_IMAGE_BYTES } from ".";

/** An image as the CLI sends a file's bytes, which the bridge rebuilds only once the input parses. */
const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).toBase64();

/** Why command `name` refuses `input`, as the lead reads it, or null when it takes it. */
function problemWith(name: keyof typeof commands, input: Record<string, unknown>) {
  const spec = commands[name];
  const parsed = spec.input.safeParse(input);
  return parsed.success ? null : inputProblem(name, spec, input, parsed.error);
}

test.each([
  ["reply", { request: "r1" }],
  ["publish", { series: "notes" }],
  ["post", {}],
] as const)("%s takes an --alt for each --image, up to 3", (name, fields) => {
  const showing = (images: number, alts = images) => ({
    ...fields,
    text: "Shipped.",
    image: Array<string>(images).fill(IMAGE),
    alt: Array<string>(alts).fill("Build times fell 5% this week"),
  });
  const refused = (problem: string) =>
    `\`${name}\` didn't run. ${problem} Run \`toy-box-slack ${name} --help\` to see what it takes.`;

  expect(
    [showing(3), showing(2, 1), showing(1, 2), showing(4)].map((input) => problemWith(name, input)),
  ).toEqual([
    null,
    refused("--alt: Give one for each --image."),
    refused("--alt: Give one for each --image."),
    refused("--image: Give at most 3."),
  ]);
});

test("an --image is at most 5 MiB, and its --alt says what it shows in at most 1000 characters, each problem said once", () => {
  /** Two of each, so a problem both images have is said once. */
  const reply = (image: string, alt: string) =>
    problemWith("reply", {
      request: "r1",
      text: "Shipped.",
      image: [image, image],
      alt: [alt, alt],
    });
  const refused = (problem: string) =>
    `\`reply\` didn't run. ${problem} Run \`toy-box-slack reply --help\` to see what it takes.`;

  expect([
    reply(new Uint8Array(MAX_IMAGE_BYTES).toBase64(), "x".repeat(1000)),
    reply(new Uint8Array(MAX_IMAGE_BYTES + 1).toBase64(), "A chart"),
    reply(IMAGE, " "),
    reply(IMAGE, "x".repeat(1001)),
  ]).toEqual([
    null,
    refused("--image: Give an image of at most 5 MiB."),
    refused("--alt: Say what the image shows."),
    refused("--alt: Keep it to 1000 characters."),
  ]);
});
