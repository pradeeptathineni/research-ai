import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { URL, URLSearchParams } from 'node:url';
const { fetch, AbortSignal } = globalThis;

// Copy this file alone into a consumer. Owner binding comes from trusted local configuration.
const [endpoint, instance, epoch, query = ''] = process.argv.slice(2);
try {
  const base = new URL(endpoint);
  assert(
    base.protocol === 'http:' &&
      base.hostname === '127.0.0.1' &&
      base.port &&
      base.pathname === '/signals-ai/__signals/api/' &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash,
    'Configure an explicit trusted loopback Signals API URL.',
  );
  assert(instance && epoch && query.length <= 2000, 'Supply bound owner scope and bounded query.');
  const headers = {
    'x-signals-provider-version': '1.0',
    'x-signals-instance-id': instance,
    'x-signals-owner-epoch': epoch,
  };
  const read = async (route) => {
    const response = await fetch(new URL(route, base), {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`${body.code}: ${body.reason ?? 'Owner read failed.'}`);
    return body;
  };
  const { capabilities } = await read('provider/capabilities');
  assert(
    capabilities?.owner === 'signals-ai' &&
      capabilities.instance_id === instance &&
      capabilities.operations.some(
        (operation) => operation.name === 'search_library' && !operation.mutating,
      ),
    'Owner does not advertise Library search.',
  );
  const page = await read('provider/library?' + new URLSearchParams({ q: query, limit: '30' }));
  assert(
    page.schema_version === '1.0' &&
      Array.isArray(page.records) &&
      page.records.length <= 30 &&
      Array.isArray(page.owner_coverage),
    'Invalid bounded Library page.',
  );
  const opened = [];
  for (const summary of page.records) {
    if (summary.open_capability !== 'owner_route') {
      opened.push({ ref: summary.ref, status: 'unavailable', reason: summary.summary });
      continue;
    }
    assert(
      summary.ref.owner === 'signals-ai' && capabilities.record_kinds.includes(summary.ref.kind),
    );
    const exact = await read(
      'provider/records?ref=' + encodeURIComponent(JSON.stringify(summary.ref)),
    );
    const sha = createHash('sha256').update(exact.content, 'utf8').digest('hex');
    assert(
      sha === summary.ref.digest &&
        exact.ref.digest === sha &&
        exact.ref.revision === `sha256:${sha}`,
      'Exact owner record changed during Library navigation.',
    );
    opened.push({
      ref: exact.ref,
      status: 'opened',
      bytes: Buffer.byteLength(exact.content),
      sha256: sha,
      content: exact.content,
    });
  }
  process.stdout.write(
    JSON.stringify({
      records: opened,
      next_cursor: page.next_cursor,
      owner_coverage: page.owner_coverage,
    }) + '\n',
  );
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
}
