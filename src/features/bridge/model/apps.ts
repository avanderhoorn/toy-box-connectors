// App names.
//
// A bridge hosts one or more apps, each one Slack app with its own tokens and its own `bridge.db`.
// The data folder's own app is `default`, and each app the owner adds with `add-app` is named after
// its folder in `apps/`. A name is lowercase so it reads the same on a Mac's case-insensitive disk,
// and it doesn't start with a hyphen, since `--app -x` would read as a flag.

import { z } from "zod";

/** The data folder's own app. */
export const DEFAULT_APP = "default";

const APP_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** An app as a command names it: `default`, or the name `add-app` gave it. */
export const appNameSchema = z
  .string()
  .regex(APP_NAME, "Give default or the name add-app gave the app, such as releases")
  .describe("The app: default, or the name add-app gave it, such as releases");

/** Why `name` can't name an app the owner adds, or null when `add-app` would take it. */
export function addedAppNameProblem(name: string): string | null {
  if (name === DEFAULT_APP) {
    return "An added app can't be named default, since that's the data folder's own app.";
  }
  if (!APP_NAME.test(name)) {
    return "An app's name is 1 to 32 lowercase letters, digits and hyphens, and doesn't start with a hyphen.";
  }
  return null;
}
