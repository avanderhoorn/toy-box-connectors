import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listApps, locateApp, type App } from "@bridge/server/apps";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import {
  readAppCredentialsFile,
  readCredentialsFile,
  writeCredential,
} from "@bridge/server/environment";
import { createTestFolder } from "@bridge/server/testFixtures";
import { createAppFolder } from "./addApp";
import type { SecretReader } from "./passphrase";
import { asksAppTokenOf, asksBotTokenOf, owner, refusalOf } from "./testFixtures";

const BOT_TOKEN = "xoxb-2222-3333-ReLeAsEs";
const APP_TOKEN = "xapp-1-A0RELEASES-4444-abcdef";

const NAME_RULE =
  "An app's name is 1 to 32 lowercase letters, digits and hyphens, and doesn't start with a hyphen.";

/** A data folder nothing has run in yet. */
function newDataFolder(): string {
  return join(createTestFolder(), ".toy-box-slack");
}

/** What `add-app` says when something is already where `app`'s folder goes. */
function alreadyThere(app: App): string {
  return `${app.folder} is already there, so add-app didn't add the ${app.name} app. To replace one of its tokens, delete that token's line from ${app.credentials} and run \`toy-box-slack serve\` at a terminal, which asks for it again.`;
}

test("asks for a new app's two tokens by its name, then saves them in a folder of its own the bridge lists", async () => {
  const dataFolder = newDataFolder();
  const typing = owner(BOT_TOKEN, APP_TOKEN);

  const app = await createAppFolder(dataFolder, "releases", typing.reader);

  expect(app).toEqual(locateApp(dataFolder, "releases"));
  expect(typing.asked).toEqual([asksBotTokenOf("releases"), asksAppTokenOf("releases")]);
  expect(typing.closed).toBe(1);
  expect(readAppCredentialsFile(app.folder)).toEqual({
    SLACK_BOT_TOKEN: BOT_TOKEN,
    SLACK_APP_TOKEN: APP_TOKEN,
  });
  expect(statSync(join(dataFolder, "apps")).mode & 0o777).toBe(0o700);
  expect(statSync(app.folder).mode & 0o777).toBe(0o700);
  expect(statSync(app.credentials).mode & 0o777).toBe(0o600);
  expect(existsSync(join(dataFolder, "credentials.env"))).toBe(false);
  expect(listApps(dataFolder).map(({ name }) => name)).toEqual(["default", "releases"]);
});

test("adds an app beside those already there, changing none of theirs", async () => {
  const dataFolder = newDataFolder();
  prepareDataFolder(dataFolder);
  writeCredential(dataFolder, "SLACK_BOT_TOKEN", "xoxb-default");
  const alpha = await createAppFolder(
    dataFolder,
    "alpha",
    owner("xoxb-alpha", "xapp-alpha").reader,
  );

  await createAppFolder(dataFolder, "beta", owner(BOT_TOKEN, APP_TOKEN).reader);

  expect(listApps(dataFolder).map(({ name }) => name)).toEqual(["default", "alpha", "beta"]);
  expect(readAppCredentialsFile(alpha.folder)).toEqual({
    SLACK_BOT_TOKEN: "xoxb-alpha",
    SLACK_APP_TOKEN: "xapp-alpha",
  });
  expect(readCredentialsFile(dataFolder)).toEqual({ SLACK_BOT_TOKEN: "xoxb-default" });
});

test.each([
  ["default", "An added app can't be named default, since that's the data folder's own app."],
  ["Releases", NAME_RULE],
  ["-releases", NAME_RULE],
  ["../../escaped", NAME_RULE],
])("refuses to name an app %p before asking or creating anything", async (name, problem) => {
  const dataFolder = newDataFolder();
  const typing = owner(BOT_TOKEN, APP_TOKEN);

  expect(await refusalOf(createAppFolder(dataFolder, name, typing.reader))).toBe(
    `${problem} Run add-app again with another name.`,
  );
  expect(typing.opened).toBe(0);
  expect(existsSync(dataFolder)).toBe(false);
});

test("refuses anything already where the app's folder goes before asking, and leaves it alone", async () => {
  const dataFolder = newDataFolder();
  const releases = await createAppFolder(
    dataFolder,
    "releases",
    owner(BOT_TOKEN, APP_TOKEN).reader,
  );
  const notes = locateApp(dataFolder, "notes");
  writeFileSync(notes.folder, "Not an app");
  const typing = owner("xoxb-replacement", "xapp-replacement");

  expect(await refusalOf(createAppFolder(dataFolder, "releases", typing.reader))).toBe(
    alreadyThere(releases),
  );
  expect(await refusalOf(createAppFolder(dataFolder, "notes", typing.reader))).toBe(
    alreadyThere(notes),
  );
  expect(typing.opened).toBe(0);
  expect(readAppCredentialsFile(releases.folder)).toEqual({
    SLACK_BOT_TOKEN: BOT_TOKEN,
    SLACK_APP_TOKEN: APP_TOKEN,
  });
  expect(readFileSync(notes.folder, "utf8")).toBe("Not an app");
});

test("refuses a folder made while the owner typed, leaving it to whatever made it", async () => {
  const dataFolder = newDataFolder();
  const app = locateApp(dataFolder, "releases");
  const typing = owner(BOT_TOKEN, APP_TOKEN);
  // Another add-app for the same name makes the folder while this one waits for an answer.
  const meanwhile = (): SecretReader => {
    const reader = typing.reader();
    return {
      read: (prompt) => {
        mkdirSync(app.folder, { recursive: true, mode: 0o700 });
        return reader.read(prompt);
      },
      close: () => reader.close(),
    };
  };

  expect(await refusalOf(createAppFolder(dataFolder, "releases", meanwhile))).toBe(
    alreadyThere(app),
  );
  expect(typing.closed).toBe(1);
  expect(existsSync(app.credentials)).toBe(false);
});

test.each([
  { kind: "bot", answers: [null] },
  { kind: "app-level", answers: [BOT_TOKEN, null] },
])("refuses a missing $kind token, creating no folder", async ({ kind, answers }) => {
  const dataFolder = newDataFolder();
  const typing = owner(...answers);

  expect(await refusalOf(createAppFolder(dataFolder, "releases", typing.reader))).toBe(
    `No Slack ${kind} token was given, so add-app didn't add the releases app.`,
  );
  expect(typing.closed).toBe(1);
  expect(existsSync(join(dataFolder, "apps"))).toBe(false);
});

test.each([
  { kind: "bot", prefix: "xoxb-", answers: [APP_TOKEN] },
  { kind: "app-level", prefix: "xapp-", answers: [BOT_TOKEN, BOT_TOKEN] },
])(
  "refuses an answer for the $kind token that isn't one, creating no folder",
  async ({ kind, prefix, answers }) => {
    const dataFolder = newDataFolder();
    const typing = owner(...answers);

    expect(await refusalOf(createAppFolder(dataFolder, "releases", typing.reader))).toBe(
      `That isn't a Slack ${kind} token, which is one word starting with ${prefix}, so it wasn't saved.`,
    );
    expect(typing.closed).toBe(1);
    expect(existsSync(join(dataFolder, "apps"))).toBe(false);
  },
);

test("refuses a data folder others could open, and an apps folder that would stop the bridge, before asking", async () => {
  const typing = owner(BOT_TOKEN, APP_TOKEN);

  const open = newDataFolder();
  prepareDataFolder(open);
  chmodSync(open, 0o755);
  expect(await refusalOf(createAppFolder(open, "releases", typing.reader))).toStartWith(
    `The data folder ${open} has mode 755, but it must be 700 so only you can open it.`,
  );
  const flat = newDataFolder();
  prepareDataFolder(flat);
  writeFileSync(join(flat, "apps"), "Not a folder");
  expect(await refusalOf(createAppFolder(flat, "releases", typing.reader))).toStartWith(
    `${join(flat, "apps")} must be the folder that holds the apps`,
  );
  const misnamed = newDataFolder();
  prepareDataFolder(misnamed);
  mkdirSync(join(misnamed, "apps", "Alpha"), { recursive: true, mode: 0o700 });
  expect(await refusalOf(createAppFolder(misnamed, "releases", typing.reader))).toStartWith(
    `${join(misnamed, "apps", "Alpha")} can't be an app's folder.`,
  );
  const leaky = newDataFolder();
  prepareDataFolder(leaky);
  mkdirSync(join(leaky, "apps", "alpha"), { recursive: true });
  chmodSync(join(leaky, "apps", "alpha"), 0o755);
  expect(await refusalOf(createAppFolder(leaky, "releases", typing.reader))).toStartWith(
    `The app folder ${join(leaky, "apps", "alpha")} has mode 755`,
  );

  expect(typing.opened).toBe(0);
  expect(existsSync(join(leaky, "apps", "releases"))).toBe(false);
});
