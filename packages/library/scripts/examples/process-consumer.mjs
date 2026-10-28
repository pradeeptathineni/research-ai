import assert from 'node:assert/strict';
import process from 'node:process';
import { URL } from 'node:url';
const { fetch, AbortSignal } = globalThis;

// Copy this file alone into an observer. Instance and request epoch come from
// trusted owner registration, never from a process row.
try {
  const [endpoint, instance, requestEpoch] = process.argv.slice(2);
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
    'Configure the exact trusted loopback Signals API URL.',
  );
  assert(instance && requestEpoch, 'Bind the trusted owner instance and request epoch.');
  const headers = {
    'x-signals-provider-version': '1.0',
    'x-signals-instance-id': instance,
    'x-signals-owner-epoch': requestEpoch,
  };
  const read = async (route) => {
    const reply = await fetch(new URL(route, base), {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    const data = await reply.json();
    if (!reply.ok) throw new Error(data.code ?? `owner_http_${reply.status}`);
    return data;
  };
  const { capabilities, deduplication } = await read('provider/capabilities');
  assert(
    capabilities.owner === 'signals-ai' &&
      capabilities.instance_id === instance &&
      capabilities.process_observation === true &&
      capabilities.contracts.some(
        (contract) => contract.id === 'K13' && contract.versions.includes('1.0'),
      ) &&
      deduplication.epoch === requestEpoch,
    'Process observation is unavailable at the bound owner.',
  );
  const snapshot = await read('provider/processes');
  assert(
    snapshot.schema_version === '1.0' &&
      snapshot.full_snapshot === true &&
      snapshot.complete_coverage === true &&
      snapshot.cursor === null &&
      snapshot.snapshot_revision === `${snapshot.store_epoch}:${snapshot.sequence}` &&
      snapshot.owner_coverage.length === 1 &&
      snapshot.owner_coverage[0].instance_id === instance &&
      snapshot.processes.every(
        (row) => row.ref.owner === 'signals-ai' && row.event_cursor === null,
      ),
    'Incomplete or incorrectly bound owner snapshot.',
  );
  process.stdout.write(JSON.stringify(snapshot) + '\n');
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'Invalid owner response.') + '\n');
  process.exitCode = 1;
}
