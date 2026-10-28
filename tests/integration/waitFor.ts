// Waiting on what a bridge does in the background.

/** Retries `assertion` until it passes, and throws its last failure once `timeoutMs` is up. */
export async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(5);
    }
  }
}
