import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { URL } from 'node:url';
const { fetch, AbortSignal } = globalThis;

// Copy this file alone into a consumer. No Signals source imports or SDK needed.
// Endpoint/owner/epoch come from trusted local configuration, never record content.
try {
  const [endpoint, instance, epoch, reference] = process.argv.slice(2);
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
  assert(instance && epoch, 'Configure the exact owner instance and epoch.');
  const headers = {
    'x-signals-provider-version': '1.0',
    'x-signals-instance-id': instance,
    'x-signals-owner-epoch': epoch,
  };
  const read = async (route) => {
    let response;
    try {
      response = await fetch(new URL(route, base), {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error('Signals provider unavailable at the configured loopback endpoint.');
    }
    const body = await response.json();
    if (!response.ok)
      throw new Error(
        `${body.code}: ${body.reason ?? 'Inspect configured owner and supported version.'}`,
      );
    return body;
  };
  const { capabilities, deduplication } = await read('provider/capabilities');
  assert(
    capabilities?.schema_version === '1.0' &&
      capabilities.owner === 'signals-ai' &&
      capabilities.instance_id === instance &&
      capabilities.availability === 'available' &&
      deduplication?.identity === instance &&
      deduplication.epoch === epoch,
    'Provider owner/version unavailable or incompatible.',
  );
  assert(
    capabilities.contracts.some(
      (contract) => contract.id === 'K12' && contract.versions.includes('1.0'),
    ) &&
      capabilities.operations.some(
        (operation) => operation.name === 'read_record' && operation.mutating === false,
      ),
    'Exact record reading is unsupported.',
  );
  const ref = JSON.parse(reference);
  assert(
    ref.owner === 'signals-ai' && capabilities.record_kinds.includes(ref.kind),
    'Unsupported reference owner/kind.',
  );
  const record = await read('provider/records?ref=' + encodeURIComponent(JSON.stringify(ref)));
  assert(
    record.schema_version === '1.0' &&
      record.instance_id === instance &&
      record.owner_epoch === epoch &&
      record.content_type === 'application/json' &&
      record.encoding === 'utf8' &&
      typeof record.content === 'string',
    'Invalid record response.',
  );
  const digest = createHash('sha256').update(record.content, 'utf8').digest('hex');
  assert(
    record.ref.owner === ref.owner &&
      record.ref.kind === ref.kind &&
      record.ref.id === ref.id &&
      record.ref.digest === digest &&
      record.ref.revision === 'sha256:' + digest &&
      (ref.digest === null || ref.digest === digest) &&
      (ref.revision === null || ref.revision === record.ref.revision),
    'Wrong owner record or changed exact revision.',
  );
  process.stdout.write(JSON.stringify({ ref: record.ref, content: record.content }) + '\n');
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : 'Invalid provider configuration.') + '\n',
  );
  process.exitCode = 1;
}
