import { loadPublicCorpus } from './public-corpus.js';
const { bundles, options } = await loadPublicCorpus();
if (
  options.some(
    (option) =>
      option.quality?.level !== 'high' ||
      option.claims.some((claim) => claim.freshness !== 'current'),
  )
)
  throw new Error('Default public findings must have high signal and current claim review.');
console.log(
  JSON.stringify({
    bundles: bundles.length,
    highSignalOptions: options.length,
    sourceBinding: 'validated',
    mode: 'deterministic validation; model ratings remain declared judgment',
  }),
);
