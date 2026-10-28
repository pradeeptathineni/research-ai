import { format } from 'prettier';
import { parseEvidenceBundle, requireUniqueJsonKeys } from '../../domain/src/evidence-exchange.js';
import type { PublicAdmission } from '../../domain/src/public-corpus.js';

/** One editable record owns evidence and review; interchange bytes are derived for pinned consumers. */
export async function readPublicRecord(raw: string, file: string) {
  if (Buffer.byteLength(raw) > 262144) throw new Error('Public record exceeds byte budget.');
  requireUniqueJsonKeys(raw);
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    value.recordVersion !== 1 ||
    Object.keys(value).sort().join(',') !== 'encoding,evidence,recordVersion,review' ||
    !['interchange-v1', 'pretty-json-v1'].includes(String(value.encoding)) ||
    !value.review ||
    typeof value.review !== 'object' ||
    Array.isArray(value.review) ||
    'file' in value.review
  )
    throw new Error('Public record has unknown fields or encoding.');
  const review = value.review as Omit<PublicAdmission, 'file'>;
  const bytes = await encodePublicEvidence(value.evidence, String(value.encoding));
  const bundle = parseEvidenceBundle(bytes, review.digest);
  return { bundle, bytes, admission: { ...review, file } };
}

export async function encodePublicEvidence(evidence: unknown, encoding: string) {
  if (!['interchange-v1', 'pretty-json-v1'].includes(encoding))
    throw new Error('Unknown evidence encoding.');
  return encoding === 'pretty-json-v1'
    ? `${JSON.stringify(evidence, null, 2)}\n`
    : await format(JSON.stringify(evidence), { parser: 'json', printWidth: 100 });
}
