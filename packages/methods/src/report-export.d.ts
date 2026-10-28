import type { ResearchReport } from './index.js';

/** Validates current report content and returns a self-contained, offline HTML document. */
export function exportReportHtml(report: ResearchReport): string;
