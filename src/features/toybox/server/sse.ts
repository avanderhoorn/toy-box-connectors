// Server-sent events as Toy Box frames them.
//
// Parses a response body the way the HTML standard's event stream interpretation does, so a frame
// split across chunks, a CRLF and a comment all read as Toy Box meant them. The bridge reads only
// `data`.

// A CR that ends the buffer may be the first half of a CRLF, so it waits for the next chunk.
const LINE_BREAK = /\r\n|\r(?!$)|\n/;

/** Reads `body` as an event stream. An event the stream ends inside is never dispatched. */
export async function* readServerSentEvents(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* takeLines();
  }
  // Nothing follows a CR the body ended with, so it was a whole line break.
  buffer = buffer.replace(/\r$/, "\n");
  yield* takeLines();

  function* takeLines(): Generator<string> {
    for (let match = LINE_BREAK.exec(buffer); match; match = LINE_BREAK.exec(buffer)) {
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line === "") {
        if (data.length) yield data.join("\n");
        data = [];
        continue;
      }
      const colon = line.indexOf(":");
      if (colon === 0) continue;
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
    }
  }
}
