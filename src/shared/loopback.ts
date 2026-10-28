// Loopback URLs.
//
// The bridge talks only to services on this Mac. A URL from the environment
// that names any other host could carry a token or wake a lead somewhere else,
// so it's refused instead of fetched.

/** `value` as a URL when it's plain http on this Mac, or undefined when it names anywhere else. */
export function parseLoopbackUrl(value: string): URL | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username || url.password) return undefined;
  return isLoopbackHost(url.hostname) ? url : undefined;
}

// URL already lowercases names and turns shorthand like 127.1 into four decimal octets.
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}
