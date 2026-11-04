const maxResponseBytes = 120_000;
const doiPattern = /^10\.[0-9]{4,9}\/\S+$/i;

/** Fetches one explicitly selected public DOI without sending saved topic data. */
export async function fetchCrossrefWork(
  doi: string,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  if (doi.length > 200 || !doiPattern.test(doi)) throw new Error('invalid_saved_doi');
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const response = await fetcher(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`crossref_http_${response.status}`);
  if (!response.body) throw new Error('crossref_response_missing');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) throw new Error('crossref_response_too_large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error('crossref_response_invalid_json');
  }
}
