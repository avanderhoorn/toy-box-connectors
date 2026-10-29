/** Refusals name a secret's category, never its value. This is a guardrail, not a DLP guarantee. */
export type OutputProblem =
  | "slack_token"
  | "github_token"
  | "anthropic_key"
  | "openai_key"
  | "aws_key"
  | "private_key"
  | "url_credentials";

const secretShapes: readonly [OutputProblem, RegExp][] = [
  ["slack_token", /\b(?:xox[baprs]-|xapp-|xoxe[.-])[A-Za-z0-9._-]+/],
  ["github_token", /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai_key", /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}/],
  ["aws_key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["aws_key", /\baws[_ -]?secret[_ -]?access[_ -]?key[\s"']*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i],
  ["private_key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
];

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
