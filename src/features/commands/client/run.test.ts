import { describe, expect, mock, onTestFinished, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { commandSocketPath } from "@bridge/server/socket";
import { createTestFolder } from "@bridge/server/testFixtures";
import type { Banner } from "@commands/model/banner";
import { commandContract } from "@commands/model/contract";
import { commandRequestSchema, type CommandRequest } from "@commands/model/protocol";
import { callCommand, runCommandLine, type CommandLineOptions } from "./run";

const AT = Date.parse("2026-10-27T16:00:00Z");

const healthy: Banner = { slack: "connected", coverage: "complete", warnings: [], restore: null };
const banner = "> Slack: connected · coverage complete";

const note = commandContract({
  description: "Leave a note in the channel",
  roles: ["lead", "operator"],
  scope: "channel",
  input: z.object({ text: z.string().min(1).describe("The note") }).strict(),
  stdin: "text",
  result: z.object({ noted: z.string() }).strict(),
  present: (result) => `Noted: ${result.noted}`,
});

function noted(text: unknown) {
  return { version: 1, at: AT, banner: healthy, result: { noted: text } };
}

type Call = { path: string; contentType: string | null; request: CommandRequest };

/**
 * A bridge listening in `dataFolder` that answers every call with `answer`, recording each call
 * after checking it the way the real bridge does.
 */
function startBridge(
  answer: (call: Call) => Response | Promise<Response>,
  dataFolder = createTestFolder(),
) {
  const calls: Call[] = [];
  const server = Bun.serve({
    unix: commandSocketPath(dataFolder),
    async fetch(request) {
      const call = {
        path: new URL(request.url).pathname,
        contentType: request.headers.get("content-type"),
        request: commandRequestSchema.parse(await request.json()),
      };
      calls.push(call);
      return answer(call);
    },
  });
  onTestFinished(() => server.stop(true));
  return { dataFolder, calls, server };
}

/**
 * Runs `toy-box-slack note <args>` for the bridge in `dataFolder`, or in the home folder's when
 * it's undefined, with `stdin` piped in.
 */
async function runNote(
  dataFolder: string | undefined,
  args: string[],
  {
    stdin = null,
    env = {},
    ...options
  }: Omit<CommandLineOptions, "print"> & { stdin?: string | null } = {},
) {
  const printed = { stdout: "", stderr: "" };
  const exitCode = await runCommandLine("note", note, args, {
    env: { TOY_BOX_SLACK_HOME: dataFolder, ...env },
    home: createTestFolder(),
    readStdin: async () => stdin,
    print: (stream, text) => {
      printed[stream] += text;
    },
    ...options,
  });
  return { exitCode, ...printed };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe("running a command from the command line", () => {
  test("posts the call with what the environment says about the caller, and prints the answer", async () => {
    const bridge = startBridge(() => Response.json(noted("Ship it")));
    const env = { COPILOT_AGENT_SESSION_ID: "toybox-link", NITRO_PORT: "3100" };

    expect(await runNote(bridge.dataFolder, ["--text", "Ship it"], { env })).toEqual({
      exitCode: 0,
      stdout: `${banner}\n\nNoted: Ship it\n`,
      stderr: "",
    });
    expect(bridge.calls).toEqual([
      {
        path: "/v1/commands/note",
        contentType: "application/json",
        request: {
          caller: { sessionId: "toybox-link", toyBoxPort: 3100, channelId: null },
          input: { text: "Ship it" },
        },
      },
    ]);
  });

  test("waits a minute for the bridge's answer", async () => {
    const timeout = spyOn(AbortSignal, "timeout");
    onTestFinished(() => timeout.mockRestore());
    const bridge = startBridge(() => Response.json(noted("Ship it")));

    expect((await runNote(bridge.dataFolder, ["--text", "Ship it"])).exitCode).toBe(0);
    expect(timeout.mock.calls).toEqual([[60_000]]);
  });

  test("forwards the channel --channel names, and --json prints the answer as it came", async () => {
    const bridge = startBridge(() => Response.json(noted("Ship it")));

    expect(
      await runNote(bridge.dataFolder, ["--channel", "design", "--text", "Ship it", "--json"]),
    ).toEqual({ exitCode: 0, stdout: json(noted("Ship it")), stderr: "" });
    expect(bridge.calls.map((call) => call.request.caller)).toEqual([
      { sessionId: null, toyBoxPort: null, channelId: "design" },
    ]);
  });

  test("prints a refusal on stderr, or as JSON on stdout with --json, and exits 1", async () => {
    const refusal = {
      version: 1,
      at: AT,
      banner: healthy,
      refused: { rule: "link_paused", message: "The link is paused." },
    };
    const bridge = startBridge(() => Response.json(refusal, { status: 409 }));

    expect(await runNote(bridge.dataFolder, ["--text", "Ship it"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${banner}\n\nThe link is paused.\n`,
    });
    expect(await runNote(bridge.dataFolder, ["--text", "Ship it", "--json"])).toEqual({
      exitCode: 1,
      stdout: json(refusal),
      stderr: "",
    });
  });

  test("reads the text from stdin when no option sets it, without the heredoc's last newline", async () => {
    const bridge = startBridge(({ request }) => Response.json(noted(request.input.text)));

    const { exitCode } = await runNote(bridge.dataFolder, [], { stdin: "  Notes\n\n- One\n" });

    expect(exitCode).toBe(0);
    expect(bridge.calls.map((call) => call.request.input)).toEqual([{ text: "  Notes\n\n- One" }]);
  });

  test("never reads stdin when an option sets the text", async () => {
    const bridge = startBridge(() => Response.json(noted("Ship it")));
    const readStdin = mock(async () => "From stdin");

    expect((await runNote(bridge.dataFolder, ["--text", "Ship it"], { readStdin })).exitCode).toBe(
      0,
    );
    expect(readStdin).not.toHaveBeenCalled();
    expect(bridge.calls.map((call) => call.request.input)).toEqual([{ text: "Ship it" }]);
  });

  test.each([null, "", " \n\n"])(
    "refuses %p on stdin as no text, without calling the bridge",
    async (stdin) => {
      const bridge = startBridge(() => Response.json(noted("Ship it")));

      expect(await runNote(bridge.dataFolder, [], { stdin })).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "`note` needs --text, or its text on stdin. Run `toy-box-slack note --help`.\n",
      });
      expect(bridge.calls).toEqual([]);
    },
  );

  test("refuses a mistake on the command line even when no bridge is running", async () => {
    const dataFolder = createTestFolder();
    const message = "`note` has no option --bogus. Run `toy-box-slack note --help`.";

    expect(await runNote(dataFolder, ["--bogus"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${message}\n`,
    });
    expect(await runNote(dataFolder, ["--bogus", "--json"])).toEqual({
      exitCode: 1,
      stdout: json({ error: message }),
      stderr: "",
    });
  });

  test("finds the bridge in ~/.toy-box-slack when TOY_BOX_SLACK_HOME is unset", async () => {
    const home = createTestFolder();
    mkdirSync(join(home, ".toy-box-slack"));
    const bridge = startBridge(() => Response.json(noted("Ship it")), join(home, ".toy-box-slack"));

    expect((await runNote(undefined, ["--text", "Ship it"], { home })).exitCode).toBe(0);
    expect(bridge.calls).toHaveLength(1);
  });

  test("refuses a relative TOY_BOX_SLACK_HOME, which names another folder for the bridge", async () => {
    expect(await runNote("data", ["--text", "Ship it"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `TOY_BOX_SLACK_HOME must be an absolute path, but it's "data".\n`,
    });
  });
});

describe("explaining a call without an answer", () => {
  const start = "Whoever runs the bridge can start it with `toy-box-slack serve`.";
  const check = "Check `toy-box-slack status` before you run `note` again.";

  test("exits 2 when no bridge is running for the data folder", async () => {
    const dataFolder = createTestFolder();
    const message = `No bridge is running for ${dataFolder}, so \`note\` didn't run. ${start}`;

    expect(await runNote(dataFolder, ["--text", "Ship it"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: `${message}\n`,
    });
    expect(await runNote(dataFolder, ["--text", "Ship it", "--json"])).toEqual({
      exitCode: 2,
      stdout: json({ error: message }),
      stderr: "",
    });
    expect((await runNote(join(dataFolder, "missing"), ["--text", "Ship it"])).exitCode).toBe(2);
  });

  test("exits 2 when the bridge stopped without removing its socket", async () => {
    const bridge = startBridge(() => Response.json(noted("Ship it")));
    const socket = commandSocketPath(bridge.dataFolder);
    // Stopping removes the socket, so keep it aside while the bridge stops.
    renameSync(socket, `${socket}.aside`);
    await bridge.server.stop(true);
    renameSync(`${socket}.aside`, socket);

    expect(await runNote(bridge.dataFolder, ["--text", "Ship it"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: `The bridge for ${bridge.dataFolder} has stopped, so \`note\` didn't run. ${start}\n`,
    });
  });

  // Linux refuses a connection to a file that isn't a socket, so the bridge reads as stopped.
  test.skipIf(process.platform !== "darwin")(
    "exits 2 when something other than a socket is at the socket's path",
    async () => {
      const dataFolder = createTestFolder();
      writeFileSync(commandSocketPath(dataFolder), "");

      expect(await runNote(dataFolder, ["--text", "Ship it"])).toEqual({
        exitCode: 2,
        stdout: "",
        stderr: `Something other than the bridge's socket is at ${commandSocketPath(dataFolder)}, so \`note\` didn't run. Whoever runs the bridge can remove it and start the bridge with \`toy-box-slack serve\`.\n`,
      });
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "exits 2 when this user can't open the socket",
    async () => {
      const bridge = startBridge(() => Response.json(noted("Ship it")));
      chmodSync(commandSocketPath(bridge.dataFolder), 0);

      expect(await runNote(bridge.dataFolder, ["--text", "Ship it"])).toEqual({
        exitCode: 2,
        stdout: "",
        stderr: `This user can't open ${commandSocketPath(bridge.dataFolder)}, so \`note\` didn't run. Run it as the user who runs the bridge.\n`,
      });
      expect(bridge.calls).toEqual([]);
    },
  );

  test("exits 1 when the bridge closes the connection without answering, since it may have run", async () => {
    const dataFolder = createTestFolder();
    const listener = Bun.listen({
      unix: commandSocketPath(dataFolder),
      socket: { data: (socket) => void socket.end() },
    });
    onTestFinished(() => listener.stop(true));

    expect(await runNote(dataFolder, ["--text", "Ship it"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `The bridge closed the connection before it answered \`note\`, so it may or may not have run. ${check}\n`,
    });
  });

  test.each([
    ["sends nothing", () => new Promise<Response>(() => {})],
    [
      "stops partway through its answer",
      () => {
        const body = new ReadableStream({ start: (stream) => stream.enqueue(Buffer.from("{")) });
        return new Response(body, { headers: { "Content-Type": "application/json" } });
      },
    ],
  ])(
    "exits 1 when the bridge %s before the CLI stops waiting, since it may have run",
    async (_, answer) => {
      const bridge = startBridge(answer);

      expect(await runNote(bridge.dataFolder, ["--text", "Ship it"], { timeout: 1_000 })).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: `The bridge didn't answer \`note\` within 1 second, so it may or may not have run. ${check}\n`,
      });
      expect(bridge.calls).toHaveLength(1);
    },
  );

  test("exits 1 when it can't read the answer to a command that ran", async () => {
    const bridge = startBridge(() => new Response("Ran it"));

    expect(await runNote(bridge.dataFolder, ["--text", "Ship it"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "`note` ran, but this CLI can't read the bridge's answer. That happens when the bridge runs another release of toy-box-slack. Whoever runs the bridge can restart it to run the same release as this CLI.\n",
    });
  });
});

describe("calling a command as a step of another", () => {
  test("posts the input as given, for the channel named, and returns the result", async () => {
    const bridge = startBridge(({ request }) => Response.json(noted(request.input.text)));
    const env = { TOY_BOX_SLACK_HOME: bridge.dataFolder };

    const outcome = await callCommand(
      "note",
      note,
      { text: "Ship it" },
      { env, channelId: "design" },
    );

    expect(outcome.exitCode === 0 && outcome.result.noted).toBe("Ship it");
    expect(bridge.calls.map((call) => call.request)).toEqual([
      {
        caller: { sessionId: null, toyBoxPort: null, channelId: "design" },
        input: { text: "Ship it" },
      },
    ]);
  });
});
