// How a run of the CLI ends.
//
// Every run ends with what the CLI prints and an exit code that says what happened: 0 when the
// bridge ran the command, 1 when it was refused or needs explaining, and 2 when no bridge took the
// call, so nothing ran. A call the bridge took but never answered may or may not have run, so it
// exits 1 and says so, because a lead told nothing ran would run it again.
//
// The CLI prints Markdown that opens with the bridge's banner. `--json` prints the bridge's answer
// as it came, or an error object when the CLI explains instead.

import { z } from "zod";
import { presentBanner } from "./banner";
import type { CommandContract } from "./contract";
import { commandErrorSchema, commandRefusalSchema, commandResultSchema } from "./protocol";

/** 0 when the command ran, 1 when it was refused or needs explaining, 2 when no bridge took it. */
export type ExitCode = 0 | 1 | 2;

/** What one run of the CLI prints, and how it exits. A run that exits 0 carries the result. */
export type CommandOutcome<Result = unknown> = {
  /** Markdown for the lead or a person at a terminal. */
  text: string;
  /** What `--json` prints. */
  json: unknown;
} & ({ exitCode: 0; result: Result } | { exitCode: 1 | 2 });

/** Why the CLI has no answer to a call. */
export type NoAnswer =
  /** No socket is at the path, so no bridge is running for the data folder. */
  | { kind: "missing" }
  /** A socket is there, but the bridge that made it has stopped. */
  | { kind: "stopped" }
  /** Something other than a socket is at the path. */
  | { kind: "not_socket" }
  /** This process may not open the socket. */
  | { kind: "denied" }
  /** The bridge closed the connection before it answered. */
  | { kind: "lost" }
  | { kind: "timed_out"; seconds: number }
  /** The call failed some other way, which can't prove the bridge never saw it. */
  | { kind: "failed"; reason: string };

/** Where the CLI looked for the bridge. */
export type BridgeAddress = { dataFolder: string; socket: string };

/** What the bridge's answer to a call of `name` means for whoever ran it. */
export function readAnswer<Result extends z.ZodType>(
  name: string,
  contract: CommandContract<z.ZodObject, Result>,
  { status, body }: { status: number; body: unknown },
): CommandOutcome<z.output<Result>> {
  if (status === 200) {
    const ran = commandResultSchema(z.unknown()).safeParse(body);
    const result = ran.success ? contract.result.safeParse(ran.data.result) : null;
    if (ran.success && result?.success) {
      const { at, banner } = ran.data;
      const text = `${presentBanner(banner)}\n\n${contract.present(result.data, { at })}`;
      return { exitCode: 0, text, json: body, result: result.data };
    }
  } else {
    const refused = commandRefusalSchema.safeParse(body);
    if (refused.success) {
      const { banner, refused: refusal } = refused.data;
      const text = banner ? `${presentBanner(banner)}\n\n${refusal.message}` : refusal.message;
      return { exitCode: 1, text, json: body };
    }
    const error = commandErrorSchema.safeParse(body);
    if (error.success && status === 404) {
      return explain(
        1,
        `The bridge runs a release of toy-box-slack without \`${name}\`, so it didn't run. ${restart}`,
      );
    }
    if (error.success) return { exitCode: 1, text: error.data.error, json: body };
  }
  return explain(1, unreadable(name, status));
}

/**
 * Why a call that threw `error` got no answer, waiting `timeout` milliseconds. Only a failure to
 * connect proves the bridge never saw the call.
 */
export function readCallFailure(error: unknown, timeout: number): NoAnswer {
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  if (name === "TimeoutError") return { kind: "timed_out", seconds: Math.ceil(timeout / 1_000) };
  switch (code) {
    case "ENOENT":
    case "ENOTDIR":
    // A path too long to exist can't hold a socket.
    case "ENAMETOOLONG":
      return { kind: "missing" };
    case "ECONNREFUSED":
      return { kind: "stopped" };
    case "ENOTSOCK":
      return { kind: "not_socket" };
    case "EACCES":
    case "EPERM":
      return { kind: "denied" };
    case "ECONNRESET":
    case "EPIPE":
      return { kind: "lost" };
    default:
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Why a call of `name` got no answer from the bridge at `address`, and what to do. */
export function explainNoAnswer(
  name: string,
  noAnswer: NoAnswer,
  { dataFolder, socket }: BridgeAddress,
): CommandOutcome<never> {
  const start = "Whoever runs the bridge can start it with `toy-box-slack serve`.";
  const check = `Check \`toy-box-slack status\` before you run \`${name}\` again.`;
  switch (noAnswer.kind) {
    case "missing":
      return explain(
        2,
        `No bridge is running for ${dataFolder}, so \`${name}\` didn't run. ${start}`,
      );
    case "stopped":
      return explain(
        2,
        `The bridge for ${dataFolder} has stopped, so \`${name}\` didn't run. ${start}`,
      );
    case "not_socket":
      return explain(
        2,
        `Something other than the bridge's socket is at ${socket}, so \`${name}\` didn't run. Whoever runs the bridge can remove it and start the bridge with \`toy-box-slack serve\`.`,
      );
    case "denied":
      return explain(
        2,
        `This user can't open ${socket}, so \`${name}\` didn't run. Run it as the user who runs the bridge.`,
      );
    case "lost":
      return explain(
        1,
        `The bridge closed the connection before it answered \`${name}\`, so it may or may not have run. ${check}`,
      );
    case "timed_out":
      return explain(
        1,
        `The bridge didn't answer \`${name}\` within ${noAnswer.seconds} ${noAnswer.seconds === 1 ? "second" : "seconds"}, so it may or may not have run. ${check}`,
      );
    case "failed":
      return explain(
        1,
        `The call to \`${name}\` failed (${noAnswer.reason}), so it may or may not have run. ${check}`,
      );
  }
}

/** A run that ends with a message instead of the bridge's answer. */
export function explain(exitCode: 1 | 2, message: string): CommandOutcome<never> {
  return { exitCode, text: message, json: { error: message } };
}

const restart = "Whoever runs the bridge can restart it to run the same release as this CLI.";

// The bridge answers 200 only after a command ran, and refuses with a 4xx before it runs one.
function unreadable(name: string, status: number): string {
  const releases = `That happens when the bridge runs another release of toy-box-slack. ${restart}`;
  if (status === 200) {
    return `\`${name}\` ran, but this CLI can't read the bridge's answer. ${releases}`;
  }
  if (status >= 400 && status < 500) {
    return `The bridge refused \`${name}\`, but this CLI can't read why. ${releases}`;
  }
  return `The bridge couldn't finish \`${name}\`, so it may or may not have run, and this CLI can't read why. Check \`toy-box-slack status\` before you run \`${name}\` again.`;
}
