import { describe, expect, it } from 'vitest';
import { evidenceExample } from '../../test-fixtures/src/evidence.js';
import { evidenceDigest, parseEvidenceBundle, evidenceChange } from './evidence-exchange.js';

describe('evidence exchange v1', () => {
  function parse(value: unknown, allowFixture = true) {
    const bytes = JSON.stringify(value);
    return parseEvidenceBundle(bytes, evidenceDigest(bytes), { allowFixture });
  }
  it('retains exact bytes and arbitrary concepts without semantic dictionaries', () => {
    const bundle = evidenceExample();
    bundle.need.query = 'Organize a community pottery exchange';
    expect(parse(bundle).need.query).toBe(bundle.need.query);
    expect(() =>
      parseEvidenceBundle(JSON.stringify(bundle) + ' ', evidenceDigest(JSON.stringify(bundle)), {
        allowFixture: true,
      }),
    ).toThrow('digest');
  });
  it('rejects fixture promotion, unknown schemas, invalid dates and unknown references', () => {
    expect(() => parse(evidenceExample(), false)).toThrow('Fixtures');
    expect(() => parse({ ...evidenceExample(), schema_version: 2 })).toThrow('schema');
    const bundle = evidenceExample();
    bundle.claims[0]!.source_ids = ['missing'];
    expect(() => parse(bundle)).toThrow('source');
    bundle.claims[0]!.source_ids = ['s1'];
    bundle.sources[0]!.observed_at = 'bad-date';
    expect(() => parse(bundle)).toThrow('schema');
  });
  it('rejects private URLs, secrets, duplicate IDs and unsupported adoption', () => {
    for (const uri of [
      'file:///etc/passwd',
      'https://localhost/a',
      'https://user:pass@example.com',
      'https://127.0.0.1',
      'https://example.com:444',
    ]) {
      const bundle = evidenceExample();
      bundle.sources[0]!.uri = uri;
      expect(() => parse(bundle)).toThrow();
    }
    const bundle = evidenceExample();
    bundle.claims.push({ ...bundle.claims[0]! });
    expect(() => parse(bundle)).toThrow('Duplicate');
    bundle.claims.pop();
    bundle.claims[0]!.status = 'uncertain';
    expect(() => parse(bundle)).toThrow('supported');
    bundle.claims[0]!.status = 'contradicted';
    expect(() => parse(bundle)).toThrow();
    bundle.claims[0]!.status = 'supported';
    bundle.limitations = ['password=supersecret'];
    expect(() => parse(bundle)).toThrow('private');
  });
  it('does not treat refresh timestamps as decision changes; checks concept references when supplied', () => {
    const before = evidenceExample(),
      after = evidenceExample();
    after.sources[0]!.observed_at = after.created_at;
    expect(evidenceChange(before, after)).toEqual([]);
    after.claims[0]!.text = 'Changed scope';
    expect(evidenceChange(before, after)).toHaveLength(1);
    const bytes = JSON.stringify(before);
    expect(() =>
      parseEvidenceBundle(bytes, evidenceDigest(bytes), { allowFixture: true, conceptIds: [] }),
    ).toThrow('concept');
  });
  it('rejects empty conclusions and unknown policy authority', () => {
    const bundle = evidenceExample();
    bundle.candidates = [];
    bundle.limitations = [];
    expect(() => parse(bundle)).toThrow('limitation');
    bundle.extensions = { policy: 'pretend' };
    expect(() => parse(bundle)).toThrow();
  });
  it('rejects acquisition fixture laundering and reserved host metadata', () => {
    const bundle = evidenceExample('agent-assisted');
    bundle.extensions = { 'signals.acquisition': { fixture: true } };
    expect(() => parse(bundle, false)).toThrow('Fixture');
    delete bundle.extensions;
    bundle.sources[0]!.uri = 'https://machine.lan/source';
    expect(() => parse(bundle, false)).toThrow('reserved');
  });
  it('checks decoded strings, future observations and UTF-8 byte budgets', () => {
    const bundle = evidenceExample('agent-assisted');
    bundle.limitations = ['/Users/private/project'];
    const bytes = JSON.stringify(bundle).replace('/Users', '\\u002fUsers');
    expect(() => parseEvidenceBundle(bytes, evidenceDigest(bytes))).toThrow('private');
    bundle.limitations = ['bounded'];
    bundle.sources[0]!.observed_at = '2027-01-01T00:00:00Z';
    expect(() => parse(bundle)).toThrow('postdates');
    expect(() => parseEvidenceBundle('é'.repeat(140000), 'a'.repeat(64))).toThrow('byte budget');
  });
  it('rejects duplicate JSON names, future creation and extension authority or private scope', () => {
    const bundle = evidenceExample('agent-assisted');
    const bytes = JSON.stringify(bundle).replace(
      '"mode":"agent-assisted"',
      '"mode":"fixture","\\u006dode":"agent-assisted"',
    );
    expect(() => parseEvidenceBundle(bytes, evidenceDigest(bytes))).toThrow('Duplicate JSON');
    bundle.created_at = '2100-01-01T00:00:00Z';
    expect(() => parse(bundle)).toThrow('Future');
    bundle.created_at = '2026-10-05T12:00:00Z';
    bundle.extensions = { 'context.policy_id': 'invented' };
    expect(() => parse(bundle)).toThrow();
    bundle.extensions = { 'context.privacy_scope': 'private' };
    expect(() => parse(bundle)).toThrow();
    let deep: unknown = 'bounded';
    for (let depth = 0; depth < 40; depth++) deep = [deep];
    bundle.extensions = { 'example.nested': deep };
    expect(() => parse(bundle)).toThrow('nesting budget');
  });
});
