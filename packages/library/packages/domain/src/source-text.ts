import { Type, type Static } from 'typebox';

export const sourceTextSchema = Type.Enum(['text-v2', 'text-v3']);
export type SourceText = Static<typeof sourceTextSchema>;
export const currentHtmlText: SourceText = 'text-v3';
export const supportedSourceText = (value: unknown): value is SourceText =>
  value === 'text-v2' || value === 'text-v3';
export const sourceTextRank = (value?: SourceText) =>
  value === 'text-v3' ? 3 : value === 'text-v2' ? 2 : 0;
