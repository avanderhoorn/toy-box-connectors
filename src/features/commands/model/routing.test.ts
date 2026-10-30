import { expect, test } from "bun:test";
import { routeCommand, type CommandRoute, type RoutedCall } from "./routing";

/** A lead's call in a Toy Box channel that links through nothing, unless `call` says otherwise. */
function route(call: Partial<RoutedCall>) {
  return routeCommand({
    name: "inbox",
    channelId: "toybox-link",
    app: undefined,
    linkedThrough: null,
    hosted: ["default", "releases"],
    ...call,
  });
}

const notRunning = (app: string, runs: string) =>
  `The bridge isn't running an app named ${app}, so nothing changed. It runs ${runs}. To run ${app}, add it with \`toy-box-slack add-app ${app}\` unless you already did, and then restart the bridge.`;

test.each<{ title: string; call: Partial<RoutedCall>; route: CommandRoute }>([
  {
    title: "links through the app the channel links through, which --app may name too",
    call: { name: "link", app: "default", linkedThrough: "default" },
    route: { kind: "app", app: "default" },
  },
  {
    title:
      "refuses an app the bridge doesn't run before another the channel doesn't link through, naming the ones it does",
    call: {
      name: "link",
      app: "support",
      linkedThrough: "releases",
      hosted: ["default", "releases", "triage"],
    },
    route: {
      kind: "refused",
      message: notRunning("support", "the default, releases, and triage apps"),
    },
  },
])("$title", ({ call, route: expected }) => {
  expect(route(call)).toEqual(expected);
});
