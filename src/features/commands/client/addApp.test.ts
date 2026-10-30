import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateApp, type App } from "@bridge/server/apps";
import { prepareDataFolder } from "@bridge/server/dataFolder";
import { readAppCredentialsFile } from "@bridge/server/environment";
import { createTestFolder } from "@bridge/server/testFixtures";
import { createAppFolder } from "./addApp";
import type { SecretReader } from "./secrets";
import { owner, refusalOf } from "./testFixtures";

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

test('refuses to name an app "../../escaped" before asking or creating anything', async () => {
  const dataFolder = newDataFolder();
  const typing = owner(BOT_TOKEN, APP_TOKEN);

  expect(await refusalOf(createAppFolder(dataFolder, "../../escaped", typing.reader))).toBe(
    `${NAME_RULE} Run add-app again with another name.`,
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

test("refuses a missing bot token, creating no folder", async () => {
  const dataFolder = newDataFolder();
  const typing = owner(null);

  expect(await refusalOf(createAppFolder(dataFolder, "releases", typing.reader))).toBe(
    "No Slack bot token was given, so add-app didn't add the releases app.",
  );
  expect(typing.closed).toBe(1);
  expect(existsSync(join(dataFolder, "apps"))).toBe(false);
});

test("refuses a data folder others could open, and an app folder that would stop the bridge, before asking", async () => {
  const typing = owner(BOT_TOKEN, APP_TOKEN);

  const open = newDataFolder();
  prepareDataFolder(open);
  chmodSync(open, 0o755);
  expect(await refusalOf(createAppFolder(open, "releases", typing.reader))).toStartWith(
    `The data folder ${open} has mode 755, but it must be 700 so only you can open it.`,
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
