// The bridge's socket.
//
// Commands reach the bridge only through `bridge.sock` in its data folder. The socket is created
// for its owner alone, inside a folder only its owner can open, but every Toy Box agent runs as
// that same user, so the socket can't tell callers apart. The bridge works out who's calling from
// what each call says about its caller.

import { rmSync } from "node:fs";

export interface CommandSocket {
  /** Stops taking calls, and waits for those in flight until the grace period cuts them off. */
  stop(): Promise<void>;
}

export type CommandSocketOptions = {
  /** How long calls in flight may take to finish once the bridge stops. */
  grace?: number;
};

/**
 * Answers calls on the Unix socket at `path` with `answer`, replacing any socket a stopped bridge
 * left there. Only the holder of the bridge lock may listen, so no running bridge owns that socket.
 */
export function listenForCommands(
  path: string,
  answer: (request: Request) => Promise<Response>,
  { grace = 15_000 }: CommandSocketOptions = {},
): CommandSocket {
  rmSync(path, { force: true });
  // The socket file takes its mode from the umask, so nobody else can connect even for a moment.
  const umask = process.umask(0o177);
  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({
      unix: path,
      development: false,
      fetch: answer,
      error(error) {
        console.error("Couldn't answer a call on the bridge's socket:", error);
        return Response.json(
          { error: "The bridge couldn't answer. Its log says why." },
          { status: 500 },
        );
      },
    });
  } finally {
    process.umask(umask);
  }
  return {
    async stop() {
      const cutOff = setTimeout(() => void server.stop(true), grace);
      try {
        await server.stop();
      } finally {
        clearTimeout(cutOff);
      }
    },
  };
}
