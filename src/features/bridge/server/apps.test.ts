import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_APP } from "@bridge/model/apps";
import { listApps, locateApp, readAppTokens } from "./apps";
import { createTestFolder, refusalOf } from "./testFixtures";

/** Makes the folder of an app named `name` in `dataFolder`, as `add-app` does, and returns it. */
function addAppFolder(dataFolder: string, name: string): string {
  const folder = join(dataFolder, "apps", name);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return folder;
}

/** Writes `text` to the `credentials.env` in `folder`, readable by its owner alone. */
function writeCredentials(folder: string, text: string): void {
  writeFileSync(join(folder, "credentials.env"), text, { mode: 0o600 });
}

describe("the apps in a data folder", () => {
  test("are default alone until there's an apps/ folder, with default's files in the data folder", () => {
    const dataFolder = createTestFolder();

    expect(listApps(dataFolder)).toEqual([
      {
        name: DEFAULT_APP,
        folder: dataFolder,
        credentials: join(dataFolder, "credentials.env"),
        database: join(dataFolder, "bridge.db"),
        lock: join(dataFolder, "bridge.lock"),
      },
    ]);
  });

  test("are default and then every folder in apps/ by name, each with its own files", () => {
    const dataFolder = createTestFolder();
    for (const name of ["releases", "ops-2", "alerts", "z", "builds"])
      addAppFolder(dataFolder, name);

    const apps = listApps(dataFolder);
    expect(apps.map(({ name }) => name)).toEqual([
      DEFAULT_APP,
      "alerts",
      "builds",
      "ops-2",
      "releases",
      "z",
    ]);
    const folder = join(dataFolder, "apps", "releases");
    expect(apps[4]).toEqual({
      name: "releases",
      folder,
      credentials: join(folder, "credentials.env"),
      database: join(folder, "bridge.db"),
      lock: join(folder, "bridge.lock"),
    });
  });

  test("ignore what in apps/ isn't a folder, such as the .DS_Store Finder writes", () => {
    const dataFolder = createTestFolder();
    const apps = join(addAppFolder(dataFolder, "releases"), "..");
    writeFileSync(join(apps, ".DS_Store"), "");
    writeFileSync(join(apps, "notes"), "");
    symlinkSync(join(dataFolder, "missing"), join(apps, "gone"));
    const elsewhere = join(createTestFolder(), "ops");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(apps, "ops"));

    expect(listApps(dataFolder).map(({ name }) => name)).toEqual([DEFAULT_APP, "ops", "releases"]);
  });

  test("stop the bridge at a folder in apps/ whose name can't name an app", () => {
    for (const name of ["Releases", "-x", "re_leases", ".hidden", "a".repeat(33)]) {
      const dataFolder = createTestFolder();
      const folder = addAppFolder(dataFolder, name);

      expect(refusalOf(() => listApps(dataFolder))).toBe(
        `${folder} can't be an app's folder. An app's name is 1 to 32 lowercase letters, digits and hyphens, and doesn't start with a hyphen. Rename it or move it out of ${join(dataFolder, "apps")}, and start the bridge again.`,
      );
    }
  });

  test("stop the bridge at a folder in apps/ named default, which is the data folder's own app", () => {
    const dataFolder = createTestFolder();
    const folder = addAppFolder(dataFolder, DEFAULT_APP);

    expect(refusalOf(() => listApps(dataFolder))).toBe(
      `${folder} can't be an app's folder. An added app can't be named default, since that's the data folder's own app. Rename it or move it out of ${join(dataFolder, "apps")}, and start the bridge again.`,
    );
  });

  test("stop the bridge at an app folder others could open", () => {
    const dataFolder = createTestFolder();
    const folder = addAppFolder(dataFolder, "releases");

    for (const mode of [0o750, 0o755, 0o777, 0o710, 0o701, 0o600]) {
      chmodSync(folder, mode);
      expect(refusalOf(() => listApps(dataFolder))).toBe(
        `The app folder ${folder} has mode ${mode.toString(8)}, but it must be 700 so only you can open it. Run \`chmod 700 ${folder}\` and start the bridge again.`,
      );
    }
  });

  test("stop the bridge when apps/ is a file", () => {
    const dataFolder = createTestFolder();
    const apps = join(dataFolder, "apps");
    writeFileSync(apps, "");

    expect(refusalOf(() => listApps(dataFolder))).toBe(
      `${apps} must be the folder that holds the apps \`toy-box-slack add-app\` adds, but it's a file. Move it away and start the bridge again.`,
    );
  });
});

describe("an app's tokens", () => {
  test("are default's from the environment first and credentials.env next, where empty counts as unset", () => {
    const dataFolder = createTestFolder();
    const app = locateApp(dataFolder, DEFAULT_APP);
    expect(readAppTokens(app, {})).toEqual({ botToken: null, appToken: null });

    writeCredentials(dataFolder, "SLACK_BOT_TOKEN=xoxb-file\nSLACK_APP_TOKEN=xapp-file\n");
    expect(readAppTokens(app, {})).toEqual({ botToken: "xoxb-file", appToken: "xapp-file" });
    expect(readAppTokens(app, { SLACK_BOT_TOKEN: "xoxb-env", SLACK_APP_TOKEN: "" })).toEqual({
      botToken: "xoxb-env",
      appToken: "xapp-file",
    });

    writeCredentials(dataFolder, "SLACK_BOT_TOKEN=\n");
    expect(readAppTokens(app, { SLACK_APP_TOKEN: "" })).toEqual({ botToken: null, appToken: null });
  });

  test("are an added app's from its own credentials.env alone, never the environment or default's", () => {
    const dataFolder = createTestFolder();
    writeCredentials(dataFolder, "SLACK_BOT_TOKEN=xoxb-default\nSLACK_APP_TOKEN=xapp-default\n");
    const app = locateApp(dataFolder, "releases");
    addAppFolder(dataFolder, app.name);
    const env = { SLACK_BOT_TOKEN: "xoxb-env", SLACK_APP_TOKEN: "xapp-env" };
    expect(readAppTokens(app, env)).toEqual({ botToken: null, appToken: null });

    writeCredentials(app.folder, "SLACK_BOT_TOKEN=xoxb-releases\nSLACK_APP_TOKEN=\n");
    expect(readAppTokens(app, env)).toEqual({ botToken: "xoxb-releases", appToken: null });
  });

  test("are refused when an added app's credentials.env sets anything else, since the rest is the bridge's", () => {
    const dataFolder = createTestFolder();
    const app = locateApp(dataFolder, "releases");
    addAppFolder(dataFolder, app.name);

    writeCredentials(
      app.folder,
      "SLACK_BOT_TOKEN=xoxb-secret\nTOY_BOX_URL=http://127.0.0.1:3100\n",
    );
    expect(refusalOf(() => readAppTokens(app, {}))).toBe(
      `${app.credentials} may set only SLACK_BOT_TOKEN and SLACK_APP_TOKEN.\n✖ Unrecognized key: "TOY_BOX_URL"`,
    );
  });

  test("are refused when others could read or write an added app's credentials.env", () => {
    const dataFolder = createTestFolder();
    const app = locateApp(dataFolder, "releases");
    addAppFolder(dataFolder, app.name);
    writeCredentials(app.folder, "SLACK_BOT_TOKEN=xoxb-secret\n");

    for (const mode of [0o640, 0o604, 0o620, 0o602]) {
      chmodSync(app.credentials, mode);
      expect(refusalOf(() => readAppTokens(app, {}))).toBe(
        `${app.credentials} has mode ${mode.toString(8)}, but it holds Slack tokens, so it must be 600. Run \`chmod 600 ${app.credentials}\` and start the bridge again.`,
      );
    }
  });
});
