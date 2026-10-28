import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { normalizeConsiderUrl } from '../../domain/src/url.js';
import type { ProvisionalLead } from '../../domain/src/search-contract.js';
import type { LibraryFinding } from '../../domain/src/library-search.js';
import { withWriter, readPrivateJson, atomicJson } from './search-store.js';

const schema = Type.Array(
  Type.Object(
    {
      id: Type.String({ pattern: '^lead-[a-f0-9]{24}$' }),
      uri: Type.String({ maxLength: 2048 }),
      snapshots: Type.Array(
        Type.Object(
          {
            runId: Type.String({ format: 'uuid' }),
            query: Type.String({ maxLength: 2000 }),
            savedAt: Type.String({ maxLength: 40 }),
            name: Type.String({ maxLength: 200 }),
            description: Type.String({ maxLength: 2000 }),
            limits: Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 40 }),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 128 },
      ),
    },
    { additionalProperties: false },
  ),
  { maxItems: 1000 },
);
async function state(root: string) {
  const value = await readPrivateJson(root, 'library-leads.json', [], 4000000);
  if (!Value.Check(schema, value)) throw new Error('invalid_library_leads');
  for (const lead of value) {
    normalizeConsiderUrl(lead.uri);
    if (lead.id !== leadId(lead.uri)) throw new Error('invalid_lead_identity');
    if (lead.snapshots.some((row) => !Number.isFinite(Date.parse(row.savedAt))))
      throw new Error('invalid_lead_date');
  }
  if (new Set(value.map((row) => row.id)).size !== value.length)
    throw new Error('duplicate_lead_identity');
  return value;
}
function leadId(uri: string) {
  return `lead-${createHash('sha256').update(uri).digest('hex').slice(0, 24)}`;
}
/** Retain an interesting locator as a lead, never manufacture evidence or a score. */
export async function saveLibraryLead(
  root: string,
  lead: ProvisionalLead,
  runId: string,
  query: string,
  options: { preserveFragment?: boolean } = {},
) {
  return (await saveLibraryLeads(root, [lead], runId, query, options))[0]!;
}
/** One atomic batch: a later invalid/over-limit lead cannot leave earlier leads committed. */
export async function saveLibraryLeads(
  root: string,
  leads: ProvisionalLead[],
  runId: string,
  query: string,
  options: { preserveFragment?: boolean } = {},
) {
  if (!leads.length) return [];
  const prepared = leads.map((lead) => ({
    lead,
    uri:
      normalizeConsiderUrl(lead.uri).normalizedUrl +
      (options.preserveFragment ? new URL(lead.uri).hash : ''),
  }));
  return withWriter(root, async () => {
    const records = await state(root);
    const retained = [];
    for (const { lead, uri } of prepared) {
      const id = leadId(uri);
      let record = records.find((row) => row.id === id);
      if (!record) {
        record = { id, uri, snapshots: [] };
        records.push(record);
      }
      const snapshot = {
        runId,
        query,
        savedAt: new Date().toISOString(),
        name: lead.name,
        description: lead.description,
        limits: lead.limits,
      };
      if (
        !record.snapshots.some(
          (row) =>
            row.runId === runId &&
            row.query === query &&
            row.name === lead.name &&
            row.description === lead.description &&
            JSON.stringify(row.limits) === JSON.stringify(lead.limits),
        )
      )
        record.snapshots.push(snapshot);
      if (!Value.Check(schema, records))
        throw new Error('lead_retention_limit_or_invalid_metadata');
      retained.push({ key: `lead:private:${id}`, id, state: 'saved-lead' });
    }
    await atomicJson(resolve(root, '.signals/library-leads.json'), records);
    return retained;
  });
}
export async function loadLibraryLeads(root: string): Promise<LibraryFinding[]> {
  return (await state(root)).map((record) => {
    const latest = record.snapshots.at(-1)!;
    return {
      key: `lead:private:${record.id}`,
      id: record.id,
      title: latest.name,
      uri: record.uri,
      description: latest.description,
      kind: 'lead',
      aliases: [],
      domains: [],
      capabilities: [],
      useCases: [],
      technologies: [],
      tags: [],
      sourceNames: [],
      intrinsicStrength: { policy: 'unassessed-lead', score: null },
      license: { state: 'unknown', values: [], openSource: null },
      access: { state: 'unknown', freeToUse: null },
      origin: { format: 'lead', destination: 'private', recordId: record.id },
      saved: true,
      observedAt: null,
      lead: {
        limits: latest.limits,
        query: latest.query,
        savedAt: latest.savedAt,
        history: record.snapshots,
      },
    };
  });
}
