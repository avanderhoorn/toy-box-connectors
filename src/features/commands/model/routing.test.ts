import { expect, test } from "bun:test";
import type { CommandName } from "./index";
import { routeCommand, type RoutedCall } from "./routing";

const HOSTED = ["default", "releases"];

/** A lead's call in a Toy Box channel that links through nothing, unless `call` says otherwise. */
function route(call: Partial<RoutedCall>) {
  return routeCommand({
    name: "inbox",
    channelId: "toybox-link",
    app: undefined,
    linkedThrough: null,
    hosted: HOSTED,
    ...call,
  });
}

test.each<CommandName>(["inbox", "reply", "status", "allow", "pause", "resume", "unlink", "link"])(
  "runs %s in the app the caller's Toy Box channel links through",
  (name) => {
    expect(route({ name, linkedThrough: "releases" })).toEqual({ kind: "app", app: "releases" });
  },
);

test.each<CommandName>(["inbox", "status", "allow", "resume", "unlink", "link"])(
  "runs %s in the default app when the caller's channel links through none, which refuses it as before",
  (name) => {
    expect(route({ name })).toEqual({ kind: "app", app: "default" });
    expect(route({ name, channelId: null })).toEqual(
      name === "status" ? { kind: "every" } : { kind: "app", app: "default" },
    );
  },
);

test("shows every app to a terminal's status that names no channel, and one app's to any other", () => {
  expect(route({ name: "status", channelId: null })).toEqual({ kind: "every" });
  expect(route({ name: "status", channelId: null, hosted: ["default"] })).toEqual({
    kind: "every",
  });
  expect(route({ name: "status", linkedThrough: "releases" })).toEqual({
    kind: "app",
    app: "releases",
  });
});

test("links through the app --app names while the channel links through none", () => {
  expect(route({ name: "link", app: "releases" })).toEqual({ kind: "app", app: "releases" });
  expect(route({ name: "link", app: "default" })).toEqual({ kind: "app", app: "default" });
});

test("links through the app the channel links through, which --app may name too", () => {
  expect(route({ name: "link", app: "releases", linkedThrough: "releases" })).toEqual({
    kind: "app",
    app: "releases",
  });
  expect(route({ name: "link", app: "default", linkedThrough: "default" })).toEqual({
    kind: "app",
    app: "default",
  });
});

test("refuses another app than the one the channel links through", () => {
  expect(route({ name: "link", app: "default", linkedThrough: "releases" })).toEqual({
    kind: "refused",
    message:
      "This Toy Box channel links through the releases app. Run `toy-box-slack unlink` before you link it through the default app.",
  });
  expect(route({ name: "link", app: "releases", linkedThrough: "default" })).toEqual({
    kind: "refused",
    message:
      "This Toy Box channel links through the default app. Run `toy-box-slack unlink` before you link it through the releases app.",
  });
});

test("refuses an app the bridge doesn't run, naming the ones it does", () => {
  expect(route({ name: "link", app: "releases", hosted: ["default"] })).toEqual({
    kind: "refused",
    message:
      "The bridge isn't running an app named releases, so nothing changed. It runs the default app. To run releases, add it with `toy-box-slack add-app releases` unless you already did, and then restart the bridge.",
  });
  expect(
    route({ name: "link", app: "support", hosted: ["default", "releases", "triage"] }),
  ).toEqual({
    kind: "refused",
    message:
      "The bridge isn't running an app named support, so nothing changed. It runs the default, releases, and triage apps. To run support, add it with `toy-box-slack add-app support` unless you already did, and then restart the bridge.",
  });
  expect(route({ name: "link", app: "support", linkedThrough: "releases" })).toMatchObject({
    kind: "refused",
    message: expect.stringMatching(/^The bridge isn't running an app named support,/),
  });
});
