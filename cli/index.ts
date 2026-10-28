#!/usr/bin/env bun

import { defineCommand, runMain } from "citty";

import { version } from "../package.json";

const main = defineCommand({
  meta: {
    name: "toy-box-slack",
    version,
    description: "Let a Toy Box channel's lead watch and answer a Slack channel",
  },
});

await runMain(main);
