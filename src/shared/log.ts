// Bun colors what `console.error` writes to a terminal red, which makes every line the bridge says
// there look like an error, so the bridge says what it's doing through `log` instead.

// Once nobody reads stderr, a write to it fails, and with no listener that failure would stop the
// bridge, where console.error carried on. So `log` lets it fail quietly.
process.stderr.on("error", () => {});

/** Writes one line to the bridge's log, as `log` does. */
export type Log = (...parts: unknown[]) => void;

/** Writes `parts` to stderr as one line, strings as they are and anything else as Bun shows it. */
export function log(...parts: unknown[]): void {
  const shown = parts.map((part) => (typeof part === "string" ? part : Bun.inspect(part)));
  process.stderr.write(`${shown.join(" ")}\n`);
}

/** A log whose every line starts with `[label]`, as Toy Box labels the parts of its server. */
export function labeledLog(label: string): Log {
  return (...parts) => log(`[${label}]`, ...parts);
}
