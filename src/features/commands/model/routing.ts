// Which app a command runs in.
//
// A Toy Box channel links through at most one of the apps the bridge hosts. So a command runs in
// the app the caller's channel links through, or in the default app when it links through none,
// where the refusals of a bridge with one app apply. Only `link` names an app, with --app, and
// only an app the channel could link through. A terminal's status without --channel shows every
// app.

import { DEFAULT_APP } from "@bridge/model/apps";
import type { CommandName } from "./index";

/** Where a call runs: in one app, in every app, or nowhere, and why. */
export type CommandRoute =
  | { kind: "app"; app: string }
  | { kind: "every" }
  | { kind: "refused"; message: string };

/** What decides where a call runs. */
export type RoutedCall = {
  name: CommandName;
  /** The Toy Box channel the caller acts for, or null for a terminal that named none. */
  channelId: string | null;
  /** The app the call's --app names, if it names one. */
  app: string | undefined;
  /** The app the caller's Toy Box channel links through, or null when it links through none. */
  linkedThrough: string | null;
  /** The apps the bridge hosts. */
  hosted: readonly string[];
};

export function routeCommand({
  name,
  channelId,
  app,
  linkedThrough,
  hosted,
}: RoutedCall): CommandRoute {
  if (name === "status" && channelId === null) return { kind: "every" };
  if (app === undefined) return { kind: "app", app: linkedThrough ?? DEFAULT_APP };
  if (!hosted.includes(app)) return { kind: "refused", message: notHosted(app, hosted) };
  if (linkedThrough !== null && linkedThrough !== app) {
    return {
      kind: "refused",
      message: `This Toy Box channel links through the ${linkedThrough} app. Run \`toy-box-slack unlink\` before you link it through the ${app} app.`,
    };
  }
  return { kind: "app", app };
}

function notHosted(app: string, hosted: readonly string[]): string {
  const apps = `the ${new Intl.ListFormat("en").format(hosted)} app${hosted.length > 1 ? "s" : ""}`;
  return `The bridge isn't running an app named ${app}, so nothing changed. It runs ${apps}. To run ${app}, add it with \`toy-box-slack add-app ${app}\` unless you already did, and then restart the bridge.`;
}
