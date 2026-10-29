import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { locateApp, type App } from "@bridge/server/apps";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import {
  readAppCredentialsFile,
  readCredentialsFile,
  writeCredential,
  type AppCredentials,
  type Credentials,
} from "@bridge/server/environment";
import { createTestFolder } from "@bridge/server/testFixtures";
import { askForMissingCredentials } from "./firstRun";
import { asksAppTokenOf, asksBotTokenOf, owner, refusalOf } from "./testFixtures";

const BOT_TOKEN = "xoxb-1234-5678-AbCdEf";
const APP_TOKEN = "xapp-1-A0123-4567-abcdef";
const PASSPHRASE = "correct horse battery staple";

const ASKS_BOT_TOKEN = "Paste the Slack bot token (xoxb-...): ";
const ASKS_APP_TOKEN = "Paste the Slack app-level token (xapp-...): ";
const ASKS_PASSPHRASE = [
  "Choose the owner's passphrase, which link, allow and resume ask for: ",
  "The new passphrase again: ",
];

/** A data folder as `serve` first finds it: missing, or holding just `credentials`. */
function dataFolderWith(credentials: Credentials = {}): string {
  const dataFolder = join(createTestFolder(), ".toy-box-slack");
  if (Object.keys(credentials).length === 0) return dataFolder;
  prepareDataFolder(dataFolder);
  for (const [name, value] of Object.entries(credentials)) {
    writeCredential(dataFolder, name as keyof Credentials, value);
  }
  return dataFolder;
}

/** An app `add-app` added to `dataFolder`, holding just `credentials`. */
function addedApp(dataFolder: string, name: string, credentials: AppCredentials = {}): App {
  prepareDataFolder(dataFolder);
  const app = locateApp(dataFolder, name);
  mkdirSync(app.folder, { recursive: true, mode: 0o700 });
  for (const [setting, value] of Object.entries(credentials)) {
    writeCredential(app.folder, setting as keyof AppCredentials, value);
  }
  return app;
}

test("asks a new data folder for both tokens and the passphrase, and saves them at mode 600", async () => {
  const dataFolder = dataFolderWith();
  const typing = owner(BOT_TOKEN, APP_TOKEN, PASSPHRASE, PASSPHRASE);

  const saved = await askForMissingCredentials(dataFolder, {}, typing.reader);

  const path = join(dataFolder, "credentials.env");
  expect(saved).toEqual([
    `Saved SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and OWNER_PASSPHRASE_HASH in ${path}.`,
  ]);
  expect(typing).toMatchObject({
    asked: [ASKS_BOT_TOKEN, ASKS_APP_TOKEN, ...ASKS_PASSPHRASE],
    opened: 1,
    closed: 1,
  });
  expect(statSync(dataFolder).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const { OWNER_PASSPHRASE_HASH, ...tokens } = readCredentialsFile(dataFolder);
  expect(tokens).toEqual({ SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_TOKEN: APP_TOKEN });
  expect(await Bun.password.verify(PASSPHRASE, OWNER_PASSPHRASE_HASH ?? "")).toBe(true);
});

test("asks only for what neither the environment nor credentials.env sets", async () => {
  const hash = await Bun.password.hash(PASSPHRASE, "argon2id");
  const cases = [
    {
      env: { SLACK_BOT_TOKEN: BOT_TOKEN },
      credentials: {},
      answers: [APP_TOKEN, PASSPHRASE, PASSPHRASE],
      asked: [ASKS_APP_TOKEN, ...ASKS_PASSPHRASE],
      saved: ["SLACK_APP_TOKEN", "OWNER_PASSPHRASE_HASH"],
    },
    {
      env: { SLACK_BOT_TOKEN: "", SLACK_APP_TOKEN: APP_TOKEN },
      credentials: { OWNER_PASSPHRASE_HASH: hash },
      answers: [BOT_TOKEN],
      asked: [ASKS_BOT_TOKEN],
      saved: ["SLACK_BOT_TOKEN"],
    },
    {
      env: {},
      credentials: { SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_TOKEN: APP_TOKEN },
      answers: [PASSPHRASE, PASSPHRASE],
      asked: ASKS_PASSPHRASE,
      saved: ["OWNER_PASSPHRASE_HASH"],
    },
  ];
  for (const { env, credentials, answers, asked, saved } of cases) {
    const dataFolder = dataFolderWith(credentials);
    const typing = owner(...answers);

    const said = await askForMissingCredentials(dataFolder, env, typing.reader);

    expect(typing.asked).toEqual(asked);
    const list = new Intl.ListFormat("en").format(saved);
    expect(said).toEqual([`Saved ${list} in ${join(dataFolder, "credentials.env")}.`]);
    expect(Object.keys(readCredentialsFile(dataFolder)).sort()).toEqual(
      [...Object.keys(credentials), ...saved].sort(),
    );
  }
});

test("opens no reader when the bridge has everything it needs", async () => {
  const dataFolder = dataFolderWith({
    SLACK_BOT_TOKEN: BOT_TOKEN,
    SLACK_APP_TOKEN: APP_TOKEN,
    OWNER_PASSPHRASE_HASH: await Bun.password.hash(PASSPHRASE, "argon2id"),
  });
  const typing = owner();

  expect(await askForMissingCredentials(dataFolder, {}, typing.reader)).toEqual([]);
  expect(typing.opened).toBe(0);
});

test("asks for each added app's missing tokens by its name, after the default app's, and saves them in its own folder", async () => {
  const dataFolder = dataFolderWith({ SLACK_BOT_TOKEN: BOT_TOKEN });
  const alpha = addedApp(dataFolder, "alpha");
  const beta = addedApp(dataFolder, "beta", {
    SLACK_BOT_TOKEN: "xoxb-beta",
    SLACK_APP_TOKEN: "xapp-beta",
  });
  const gamma = addedApp(dataFolder, "gamma", { SLACK_BOT_TOKEN: "xoxb-gamma" });
  const typing = owner(APP_TOKEN, "xoxb-alpha", "xapp-alpha", "xapp-gamma", PASSPHRASE, PASSPHRASE);

  const saved = await askForMissingCredentials(dataFolder, {}, typing.reader);

  expect(typing.asked).toEqual([
    ASKS_APP_TOKEN,
    asksBotTokenOf("alpha"),
    asksAppTokenOf("alpha"),
    asksAppTokenOf("gamma"),
    ...ASKS_PASSPHRASE,
  ]);
  expect(saved).toEqual([
    `Saved SLACK_APP_TOKEN and OWNER_PASSPHRASE_HASH in ${join(dataFolder, "credentials.env")}.`,
    `Saved SLACK_BOT_TOKEN and SLACK_APP_TOKEN in ${alpha.credentials}.`,
    `Saved SLACK_APP_TOKEN in ${gamma.credentials}.`,
  ]);
  expect(readAppCredentialsFile(alpha.folder)).toEqual({
    SLACK_BOT_TOKEN: "xoxb-alpha",
    SLACK_APP_TOKEN: "xapp-alpha",
  });
  expect(statSync(alpha.credentials).mode & 0o777).toBe(0o600);
  expect(readAppCredentialsFile(beta.folder)).toEqual({
    SLACK_BOT_TOKEN: "xoxb-beta",
    SLACK_APP_TOKEN: "xapp-beta",
  });
  expect(readAppCredentialsFile(gamma.folder)).toEqual({
    SLACK_BOT_TOKEN: "xoxb-gamma",
    SLACK_APP_TOKEN: "xapp-gamma",
  });
  expect(readCredentialsFile(dataFolder)).toEqual({
    SLACK_BOT_TOKEN: BOT_TOKEN,
    SLACK_APP_TOKEN: APP_TOKEN,
    OWNER_PASSPHRASE_HASH: expect.stringMatching(/^\$argon2id\$/),
  });
});

test("asks for an added app's tokens even when the environment sets the default app's", async () => {
  const hash = await Bun.password.hash(PASSPHRASE, "argon2id");
  const dataFolder = dataFolderWith({ OWNER_PASSPHRASE_HASH: hash });
  const releases = addedApp(dataFolder, "releases");
  const typing = owner("xoxb-releases", "xapp-releases");

  const env = { SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_TOKEN: APP_TOKEN };
  const saved = await askForMissingCredentials(dataFolder, env, typing.reader);

  expect(typing.asked).toEqual([asksBotTokenOf("releases"), asksAppTokenOf("releases")]);
  expect(saved).toEqual([`Saved SLACK_BOT_TOKEN and SLACK_APP_TOKEN in ${releases.credentials}.`]);
  expect(readAppCredentialsFile(releases.folder)).toEqual({
    SLACK_BOT_TOKEN: "xoxb-releases",
    SLACK_APP_TOKEN: "xapp-releases",
  });
  expect(readCredentialsFile(dataFolder)).toEqual({ OWNER_PASSPHRASE_HASH: hash });
});

test("saves a pasted token without the spaces around it", async () => {
  const dataFolder = dataFolderWith({ SLACK_APP_TOKEN: APP_TOKEN });
  const typing = owner(` ${BOT_TOKEN}  `, PASSPHRASE, PASSPHRASE);

  await askForMissingCredentials(dataFolder, {}, typing.reader);

  expect(readCredentialsFile(dataFolder).SLACK_BOT_TOKEN).toBe(BOT_TOKEN);
});

test("refuses a token that's missing or isn't one, without repeating it or saving it", async () => {
  const notBotTokens = [
    APP_TOKEN,
    "xoxb-",
    "xoxb-1234 5678",
    "xoxb-1234#5678",
    "XOXB-1234",
    "xoxe.xoxb-1-5678",
    "Bearer xoxb-1234",
  ];
  const isNot = (kind: string, prefix: string) =>
    `That isn't a ${kind}, which is one word starting with ${prefix}, so it wasn't saved.`;
  const cases = [
    {
      env: {},
      answer: null,
      asked: ASKS_BOT_TOKEN,
      refusal: "No Slack bot token was given, so toy-box-slack didn't start.",
    },
    ...notBotTokens.map((answer) => ({
      env: {},
      answer,
      asked: ASKS_BOT_TOKEN,
      refusal: isNot("Slack bot token", "xoxb-"),
    })),
    {
      env: { SLACK_BOT_TOKEN: BOT_TOKEN },
      answer: BOT_TOKEN,
      asked: ASKS_APP_TOKEN,
      refusal: isNot("Slack app-level token", "xapp-"),
    },
  ];
  for (const { env, answer, asked, refusal } of cases) {
    const dataFolder = dataFolderWith();
    const typing = owner(answer, APP_TOKEN, PASSPHRASE, PASSPHRASE);

    expect(await refusalOf(askForMissingCredentials(dataFolder, env, typing.reader))).toBe(refusal);

    expect(typing).toMatchObject({ asked: [asked], closed: 1 });
    expect(existsSync(join(dataFolder, "credentials.env"))).toBe(false);
  }
});

test("keeps what it saved before a refusal, so running again asks only for the rest", async () => {
  const dataFolder = dataFolderWith();

  const refused = askForMissingCredentials(dataFolder, {}, owner(BOT_TOKEN, null).reader);
  expect(await refusalOf(refused)).toBe(
    "No Slack app-level token was given, so toy-box-slack didn't start.",
  );
  expect(readCredentialsFile(dataFolder)).toEqual({ SLACK_BOT_TOKEN: BOT_TOKEN });

  const typing = owner(APP_TOKEN, PASSPHRASE, PASSPHRASE);
  const saved = await askForMissingCredentials(dataFolder, {}, typing.reader);
  expect(typing.asked).toEqual([ASKS_APP_TOKEN, ...ASKS_PASSPHRASE]);
  expect(saved).toEqual([
    `Saved SLACK_APP_TOKEN and OWNER_PASSPHRASE_HASH in ${join(dataFolder, "credentials.env")}.`,
  ]);
});

test("refuses an added app's missing token by the app's name, keeping what it saved before", async () => {
  const hash = await Bun.password.hash(PASSPHRASE, "argon2id");
  const dataFolder = dataFolderWith({ SLACK_BOT_TOKEN: BOT_TOKEN, OWNER_PASSPHRASE_HASH: hash });
  const releases = addedApp(dataFolder, "releases");

  const typing = owner(APP_TOKEN, null);
  expect(await refusalOf(askForMissingCredentials(dataFolder, {}, typing.reader))).toBe(
    "No Slack bot token was given for the releases app, so toy-box-slack didn't start.",
  );
  expect(typing).toMatchObject({ asked: [ASKS_APP_TOKEN, asksBotTokenOf("releases")], closed: 1 });
  expect(readCredentialsFile(dataFolder).SLACK_APP_TOKEN).toBe(APP_TOKEN);
  expect(existsSync(releases.credentials)).toBe(false);

  const again = owner("xoxb-releases", null);
  expect(await refusalOf(askForMissingCredentials(dataFolder, {}, again.reader))).toBe(
    "No Slack app-level token was given for the releases app, so toy-box-slack didn't start.",
  );
  expect(again.asked).toEqual([asksBotTokenOf("releases"), asksAppTokenOf("releases")]);
  expect(readAppCredentialsFile(releases.folder)).toEqual({ SLACK_BOT_TOKEN: "xoxb-releases" });
});

test("refuses a passphrase that's empty or typed differently twice, and saves no hash", async () => {
  const refusals = [
    [[null], "The new passphrase is empty, so it wasn't saved."],
    [[PASSPHRASE, null], "The two passphrases differ, so neither was saved."],
    [[PASSPHRASE, `${PASSPHRASE} `], "The two passphrases differ, so neither was saved."],
  ] as const;
  for (const [answers, refusal] of refusals) {
    const tokens = { SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_TOKEN: APP_TOKEN };
    const dataFolder = dataFolderWith(tokens);
    const typing = owner(...answers);

    expect(await refusalOf(askForMissingCredentials(dataFolder, {}, typing.reader))).toBe(refusal);

    expect(typing.closed).toBe(1);
    expect(readCredentialsFile(dataFolder)).toEqual(tokens);
  }
});

test("refuses what the bridge would refuse before asking anything", async () => {
  const typing = owner(BOT_TOKEN, APP_TOKEN, PASSPHRASE, PASSPHRASE);

  const env = { TOY_BOX_URL: "http://10.0.0.2:3000" };
  expect(await refusalOf(askForMissingCredentials(dataFolderWith(), env, typing.reader))).toBe(
    `TOY_BOX_URL must be an http URL on this Mac, such as http://127.0.0.1:3000, but it's "${env.TOY_BOX_URL}".`,
  );
  const shared = dataFolderWith({ SLACK_BOT_TOKEN: BOT_TOKEN });
  chmodSync(join(shared, "credentials.env"), 0o644);
  expect(await refusalOf(askForMissingCredentials(shared, {}, typing.reader))).toStartWith(
    `${join(shared, "credentials.env")} has mode 644, but it holds Slack tokens, so it must be 600.`,
  );
  const open = dataFolderWith({ SLACK_BOT_TOKEN: BOT_TOKEN });
  chmodSync(open, 0o755);
  expect(await refusalOf(askForMissingCredentials(open, {}, typing.reader))).toStartWith(
    `The data folder ${open} has mode 755, but it must be 700 so only you can open it.`,
  );
  const misnamed = dataFolderWith({ SLACK_BOT_TOKEN: BOT_TOKEN });
  mkdirSync(join(misnamed, "apps", "Releases"), { recursive: true, mode: 0o700 });
  expect(await refusalOf(askForMissingCredentials(misnamed, {}, typing.reader))).toStartWith(
    `${join(misnamed, "apps", "Releases")} can't be an app's folder.`,
  );
  const leaky = dataFolderWith({ SLACK_BOT_TOKEN: BOT_TOKEN });
  const releases = addedApp(leaky, "releases", { SLACK_BOT_TOKEN: "xoxb-releases" });
  chmodSync(releases.credentials, 0o644);
  expect(await refusalOf(askForMissingCredentials(leaky, {}, typing.reader))).toStartWith(
    `${releases.credentials} has mode 644, but it holds Slack tokens, so it must be 600.`,
  );

  expect(typing.opened).toBe(0);
});
