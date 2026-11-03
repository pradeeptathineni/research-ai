/** Read one bounded JSON body without decoding at arbitrary transport chunk boundaries. */
export async function parseJsonRequestBody(
  chunks: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<unknown> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_request_body_limit');
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new Error('invalid_request_body');
    size += chunk.byteLength;
    if (size > limit) throw new Error('request_too_large');
    parts.push(chunk);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, size));
  } catch {
    throw new Error('invalid_request_utf8');
  }
  return JSON.parse(text);
}
