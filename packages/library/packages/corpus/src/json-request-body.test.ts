import { expect, it } from 'vitest';
import { parseJsonRequestBody } from './json-request-body.js';

async function* chunks(parts: Uint8Array[]) {
  for (const part of parts) yield part;
}

it('decodes bounded JSON only after joining split UTF-8 code points', async () => {
  const exact = Buffer.from('{"label":"north 🌱","source":"caller"}', 'utf8');
  const split = exact.indexOf(Buffer.from('🌱')) + 2;
  const parsed = await parseJsonRequestBody(
    chunks([exact.subarray(0, split), exact.subarray(split)]),
    exact.byteLength,
  );
  expect(parsed).toEqual({ label: 'north 🌱', source: 'caller' });
  await expect(parseJsonRequestBody(chunks([exact]), exact.byteLength - 1)).rejects.toThrow(
    'request_too_large',
  );
  await expect(
    parseJsonRequestBody(chunks([Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])]), 20),
  ).rejects.toThrow('invalid_request_utf8');
});
