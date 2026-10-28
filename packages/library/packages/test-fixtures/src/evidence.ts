import type { EvidenceBundle } from '../../domain/src/evidence-exchange.js';

export function evidenceExample(mode: EvidenceBundle['mode'] = 'fixture'): EvidenceBundle {
  return {
    schema_version: 1,
    bundle_id: 'test-evidence',
    mode,
    created_at: '2026-10-05T12:00:00Z',
    producer: {
      repository: 'pradeeptathineni/signals-ai',
      commit: 'a'.repeat(40),
      protocol: 'signals-evidence-v1',
    },
    need: {
      query: 'Evaluate a documented resource',
      concept_ids: ['arbitrary-consumer-vocabulary'],
    },
    sources: [
      {
        id: 's1',
        uri: 'https://example.com/resource',
        title: 'Resource',
        source_class: 'first-party',
        observed_at: '2026-10-01T12:00:00Z',
        independence_group: 'publisher',
      },
    ],
    claims: [
      {
        id: 'c1',
        text: 'A documented resource has a bounded interface.',
        source_ids: ['s1'],
        status: 'supported',
      },
    ],
    candidates: [
      {
        id: 'candidate',
        name: 'Resource',
        canonical_uri: 'https://example.com/resource',
        claim_ids: ['c1'],
        disposition: 'trial',
        reason: 'Evaluate within documented scope.',
        limitations: ['Comparative benefit unknown.'],
      },
    ],
    limitations: ['Synthetic regression input; never live research proof.'],
  };
}
