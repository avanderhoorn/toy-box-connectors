import { expect, test } from "bun:test";
import { linkProblem, outputProblem, type OutputProblem } from "./safety";

const secretCases: readonly [OutputProblem, string][] = [
  ["slack_token", `xoxb-${"1".repeat(12)}-${"a".repeat(24)}`],
  ["slack_token", `xoxp-${"2".repeat(12)}-${"b".repeat(24)}`],
  ["slack_token", `xapp-1-${"A".repeat(12)}-${"c".repeat(32)}`],
  ["slack_token", `xoxe.xoxb-1-${"d".repeat(32)}`],
  ["slack_token", `xoxe-1-${"e".repeat(32)}`],
  ["github_token", `ghp_${"a".repeat(36)}`],
  ["github_token", `github_pat_${"a".repeat(22)}_${"b".repeat(59)}`],
  ["anthropic_key", `sk-ant-api03-${"a".repeat(80)}`],
  ["openai_key", `sk-${"a".repeat(48)}`],
  ["openai_key", `sk-proj-${"a".repeat(80)}`],
  ["openai_key", `sk-svcacct-${"a".repeat(80)}`],
  ["aws_key", `AKIA${"A".repeat(16)}`],
  ["aws_key", `ASIA${"B".repeat(16)}`],
  ["aws_key", `aws_secret_access_key = "${"a".repeat(40)}"`],
  ["private_key", "-----BEGIN PRIVATE KEY-----\nredacted\n-----END PRIVATE KEY-----"],
  ["private_key", "-----BEGIN RSA PRIVATE KEY-----\nredacted"],
  ["private_key", "-----BEGIN OPENSSH PRIVATE KEY-----\nredacted"],
  ["private_key", "-----BEGIN ENCRYPTED PRIVATE KEY-----\nredacted"],
  ["url_credentials", `https://${"example-user"}:${"example-password"}@example.com`],
  ["url_credentials", `ftp://${"example-user"}:${"example-password"}@example.com`],
  ["url_credentials", `https://${"example-user"}:p)ass@example.com`],
  ["url_credentials", `https://${"example-user"}:p<ass@example.com`],
];

for (const [category, secret] of secretCases) {
  test(`text containing ${category} is refused without returning the match`, () => {
    expect(outputProblem(`Do not publish this: ${secret}`)).toBe(category);
    expect(outputProblem(`\`\`\`\n${secret}\n\`\`\``)).toBe(category);
  });
}

test.each([
  "http://localhost:3000",
  "https://LOCALHOST./admin",
  "https://service.localhost/path",
  "https://host.local/path",
  "https://service.internal",
  "http://printer/status",
  "https://router.home.arpa",
  "http://0.0.0.0:3000",
  "http://10.0.0.1/a",
  "http://127.1/a",
  "http://2130706433/a",
  "http://0x7f000001/a",
  "http://0177.0.0.1/a",
  "https://100.64.0.1",
  "https://100.127.255.254",
  "http://169.254.169.254/latest",
  "https://172.16.0.1",
  "https://172.31.255.254",
  "http://192.168.1.1/a",
  "http://[::1]:3000/a",
  "http://[::]/a",
  "https://[fc00::1]",
  "https://[fdff:ffff::1]",
  "https://[fe80::1]",
  "https://[fec0::1]",
  "http://[::ffff:127.0.0.1]/a",
  "http://[::ffff:192.168.1.1]/a",
  "http://[::ffff:ac10:1]/a",
  "http://[::7f00:1]/a",
])("private clickable link %s is refused, but it is not itself a secret", (url) => {
  expect(linkProblem(url)).toBe("private_link");
  expect(outputProblem(`\`${url}\``)).toBeNull();
});

test.each([
  "https://example.com/a?q=a&b=c",
  "http://example.com",
  "https://8.8.8.8",
  "https://100.63.255.254",
  "https://100.128.0.1",
  "https://172.15.255.254",
  "https://172.32.0.1",
  "https://192.167.1.1",
  "https://[2606:4700:4700::1111]",
  "https://[::ffff:8.8.8.8]",
  "https://localhost.example.com",
  "https://local.example.com",
  "https://169.253.1.1",
  "https://169.255.1.1",
  "https://192.169.1.1",
  "https://[fbff::1]",
  "https://[fe00::1]",
  "https://[fe7f::1]",
])("public link %s is allowed", (url) => {
  expect(linkProblem(url)).toBeNull();
  expect(outputProblem(`Read [the docs](${url}).`)).toBeNull();
});

test.each([
  "javascript:alert(1)",
  "data:text/html,test",
  "file:///Users/owner/work",
  "ftp://example.com",
  "mailto:person@example.com",
  "https://user:password@example.com",
  "https://example.com:bad/path",
  "/relative/path",
])("unsafe link %s is refused without echoing it", (url) => {
  expect(linkProblem(url)).toBe("unsafe_link");
});

test("userinfo is refused in a clickable link even without a password", () => {
  for (const userinfo of ["example-user", "example-user:example-password", ":example-password"]) {
    expect(linkProblem(`https://${userinfo}@example.com`)).toBe("unsafe_link");
  }
  expect(outputProblem(`ssh://${"example-user"}@example.com`)).toBeNull();
  expect(outputProblem(`https://${"example-user"}:@example.com`)).toBeNull();
  expect(outputProblem("https://example.com:" + ":".repeat(20_000))).toBeNull();
});

test("ordinary release notes, public keys, commit IDs and key-family names are not secrets", () => {
  expect(
    outputProblem(
      [
        "Shipped changes from " + "a".repeat(40) + ".",
        "The xoxb- and ghp_ prefixes identify key families.",
        "-----BEGIN PUBLIC KEY-----\npublic material\n-----END PUBLIC KEY-----",
        "AWS account 123456789012.",
        "Read https://docs.slack.dev/reference/methods/chat.postMessage/.",
      ].join("\n"),
    ),
  ).toBeNull();
});
