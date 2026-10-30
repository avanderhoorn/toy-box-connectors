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
    title: "runs a call in the app its Toy Box channel links through",
    call: { name: "reply", linkedThrough: "releases" },
    route: { kind: "app", app: "releases" },
  },
  {
    title:
      "runs a call in the default app when its channel links through none, which refuses it as before",
    call: { name: "inbox" },
    route: { kind: "app", app: "default" },
  },
  {
    title: "runs a terminal's call that names no channel in the default app",
    call: { name: "allow", channelId: null },
    route: { kind: "app", app: "default" },
  },
  {
    title: "shows every app to a terminal's status that names no channel, however many it hosts",
    call: { name: "status", channelId: null, hosted: ["default"] },
    route: { kind: "every" },
  },
  {
    title: "links through the app --app names while the channel links through none",
    call: { name: "link", app: "releases" },
    route: { kind: "app", app: "releases" },
  },
  {
    title: "links through the app the channel links through, which --app may name too",
    call: { name: "link", app: "default", linkedThrough: "default" },
    route: { kind: "app", app: "default" },
  },
  {
    title: "refuses another app than the one the channel links through",
    call: { name: "link", app: "default", linkedThrough: "releases" },
    route: {
      kind: "refused",
      message:
        "This Toy Box channel links through the releases app. Run `toy-box-slack unlink` before you link it through the default app.",
    },
  },
  {
    title: "refuses an app the bridge doesn't run, naming the one it does",
    call: { name: "link", app: "releases", hosted: ["default"] },
    route: { kind: "refused", message: notRunning("releases", "the default app") },
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
