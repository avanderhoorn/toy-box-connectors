import { isIP } from "node:net";

/** Why text must not leave the bridge. The refusal never includes the matched value. */
export type OutputProblem =
  | "slack_token"
  | "github_token"
  | "anthropic_key"
  | "openai_key"
  | "aws_key"
  | "private_key"
  | "url_credentials"
  | "private_link"
  | "unsafe_link";

const secretShapes: readonly [OutputProblem, RegExp][] = [
  ["slack_token", /\b(?:xox[baprs]-|xapp-|xoxe[.-])[A-Za-z0-9._-]+/],
  ["github_token", /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai_key", /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}/],
  ["aws_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["aws_key", /\baws[_ -]?secret[_ -]?access[_ -]?key\s*["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i],
  ["private_key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
];

/** A content-free secret refusal, including credentials in URLs even when shown as code. */
export function outputProblem(text: string): OutputProblem | null {
  for (const [problem, shape] of secretShapes) if (shape.test(text)) return problem;
  for (const match of text.matchAll(/:\/\/[^\s/?#]*/g)) {
    const authority = match[0].slice(3);
    const at = authority.lastIndexOf("@");
    if (at < 0) continue;
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(":");
    if (colon >= 0 && colon < userinfo.length - 1) return "url_credentials";
  }
  return null;
}

/** Only HTTP(S) links without credentials, local names or private IP literals can be rendered. */
export function linkProblem(value: string): "private_link" | "unsafe_link" | null {
  if (!URL.canParse(value)) return "unsafe_link";
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return "unsafe_link";
  if (url.username || url.password) return "unsafe_link";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const address = host.startsWith("[") ? host.slice(1, -1) : host;
  const family = isIP(address);
  if (family === 4) return privateIpv4(address.split(".").map(Number)) ? "private_link" : null;
  if (family === 6) return privateIpv6(address) ? "private_link" : null;
  if (
    !host.includes(".") ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "home.arpa" ||
    host.endsWith(".home.arpa")
  )
    return "private_link";
  return null;
}

function privateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168)
  );
}

function privateIpv6(address: string): boolean {
  const [left, right] = address.split("::");
  const before = left ? left.split(":") : [];
  const after = right ? right.split(":") : [];
  const words = [
    ...before,
    ...Array<string>(8 - before.length - after.length).fill("0"),
    ...after,
  ].map((word) => Number.parseInt(word, 16));
  const first = words[0]!;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0)
    return true;
  if (words.slice(0, 6).every((word) => word === 0)) {
    if (words[6] === 0 && (words[7] === 0 || words[7] === 1)) return true;
    return privateIpv4([words[6]! >> 8, words[6]! & 0xff]);
  }
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return privateIpv4([words[6]! >> 8, words[6]! & 0xff]);
  }
  return false;
}
