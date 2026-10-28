export const kinds = [
  'software',
  'service',
  'model',
  'dataset',
  'standard',
  'practice',
  'publication',
  'learning-resource',
  'product',
  'organization',
  'other',
] as const;
export const channels = [
  'open-web',
  'primary',
  'github',
  'other-forges',
  'registries',
  'hacker-news',
  'qa',
  'reddit',
  'standards',
  'scholarly',
  'practitioners',
  'media-feeds',
] as const;
export const budgets = {
  quick: { searches: 8, documents: 20, entities: 20, seconds: 240, refinements: 1 },
  wide: { searches: 24, documents: 60, entities: 60, seconds: 600, refinements: 2 },
};
