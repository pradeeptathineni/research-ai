import { parseHTML } from 'linkedom';
import { digest, normalizeSpan } from './search-fetch.js';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

const blocks = new Set(
  'ADDRESS ARTICLE ASIDE BLOCKQUOTE BR DD DIV DL DT FIGCAPTION FIGURE FOOTER H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN OL P PRE SECTION UL'.split(
    ' ',
  ),
);
const excluded =
  'nav,[role="navigation"],script,style,iframe,object,embed,[hidden],[aria-hidden="true"]';
const noise = 'nav,[role="navigation"],script,style,iframe,object,embed';
export const explicitlyHidden = (element: Element) => {
  for (let node: Element | null = element; node; node = node.parentElement)
    if (
      node.hasAttribute('hidden') ||
      node.getAttribute('aria-hidden') === 'true' ||
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(
        node.getAttribute('style') ?? '',
      )
    )
      return true;
  return false;
};
interface Cell {
  row: number;
  domCell: number;
  rowGroup: string;
  column: number;
  rowSpan: number;
  columnSpan: number;
  tag: string;
  text: string;
  headers: string[];
  scope: string | null;
  id: string | null;
  start: number;
  end: number;
}
interface Table {
  kind: 'html-table-v1';
  table: number;
  coordinate: 'UTF16-in-normalized-text';
  ordinalCoordinate: 'zero-based-DOM-row-and-cell; logical-grid-column';
  snapshotDigest: string;
  start: number;
  end: number;
  cells: Cell[];
  grid: (number | null)[][];
  unresolved: string[];
}
const count = Type.Integer({ minimum: 0 });
const positive = Type.Integer({ minimum: 1, maximum: 200 });
const label = Type.String({ maxLength: 2000000 });
const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const tableSchema = Type.Object(
  {
    kind: Type.Literal('html-table-v1'),
    table: positive,
    coordinate: Type.Literal('UTF16-in-normalized-text'),
    ordinalCoordinate: Type.Literal('zero-based-DOM-row-and-cell; logical-grid-column'),
    snapshotDigest: hash,
    start: count,
    end: count,
    cells: Type.Array(
      Type.Object(
        {
          row: count,
          domCell: count,
          rowGroup: label,
          column: count,
          rowSpan: positive,
          columnSpan: positive,
          tag: Type.Enum(['th', 'td']),
          text: label,
          headers: Type.Array(label),
          scope: Type.Union([label, Type.Null()]),
          id: Type.Union([label, Type.Null()]),
          start: count,
          end: count,
        },
        { additionalProperties: false },
      ),
      { maxItems: 2000 },
    ),
    grid: Type.Array(Type.Array(Type.Union([count, Type.Null()]), { maxItems: 64 }), {
      maxItems: 200,
    }),
    unresolved: Type.Array(label),
  },
  { additionalProperties: false },
);
type Section = { locator: string; text: string; provenance?: unknown[] };
export const layoutProjectionDigest = (sections: Section[]) =>
  digest(
    JSON.stringify(
      sections.filter((section) =>
        section.provenance?.some(
          (value) =>
            value && typeof value === 'object' && 'kind' in value && value.kind === 'html-table-v1',
        ),
      ),
    ),
  );

/** Validates declared geometry and snapshot bindings, not raw HTML semantics or entailment. */
export function validateLayoutProjection(text: string, sections: Section[]) {
  const textHash = digest(text);
  for (const section of sections)
    for (const value of section.provenance ?? []) {
      if (
        !value ||
        typeof value !== 'object' ||
        !('kind' in value) ||
        value.kind !== 'html-table-v1'
      )
        continue;
      if (!Value.Check(tableSchema, value)) throw new Error('invalid_table_projection');
      const width = value.grid[0]?.length ?? 0;
      if (
        value.snapshotDigest !== textHash ||
        value.start > value.end ||
        value.end > text.length ||
        text.slice(value.start, value.end) !== section.text ||
        value.grid.some((row) => row.length !== width)
      )
        throw new Error('invalid_table_snapshot_binding');
      const grid: (number | null)[][] = value.grid.map(() =>
        Array<number | null>(width).fill(null),
      );
      for (const [index, cell] of value.cells.entries()) {
        if (
          cell.start < value.start ||
          cell.end > value.end ||
          cell.start > cell.end ||
          text.slice(cell.start, cell.end) !== cell.text ||
          cell.row + cell.rowSpan > grid.length ||
          cell.column + cell.columnSpan > width
        )
          throw new Error('invalid_table_cell_binding');
        for (let row = cell.row; row < cell.row + cell.rowSpan; row++)
          for (let column = cell.column; column < cell.column + cell.columnSpan; column++) {
            if (grid[row]![column] !== null && !value.unresolved.length)
              throw new Error('invalid_table_overlap');
            grid[row]![column] ??= index;
          }
      }
      if (JSON.stringify(grid) !== JSON.stringify(value.grid))
        throw new Error('invalid_table_occupancy');
    }
}
/** Inert DOM geometry only. Separators and references are generated representation metadata. */
export function htmlLayout(raw: string, title: string) {
  const { document } = parseHTML(raw);
  const all = [...document.querySelectorAll('*')];
  const removals = new Set(all.filter((node) => node.matches(excluded) || explicitlyHidden(node)));
  // Accessibility-marked content may still be displayed. These count exclusions,
  // not browser visibility or the semantic importance of omitted text.
  let excludedContentTextUnits = 0;
  for (const node of removals) {
    if (node.closest(noise) || (node.parentElement && removals.has(node.parentElement))) continue;
    const copy = node.cloneNode(true) as Element;
    for (const child of copy.querySelectorAll(noise)) child.remove();
    excludedContentTextUnits += normalizeSpan(copy.textContent ?? '').length;
  }
  let excludedStructuredDataTextUnits = 0;
  for (const node of document.querySelectorAll('script')) {
    if (!/^application\/(?:ld\+)?json$/i.test((node.getAttribute('type') ?? '').trim())) continue;
    excludedStructuredDataTextUnits += normalizeSpan(node.textContent ?? '').length;
  }
  const excludedTextCountOverflow =
    excludedContentTextUnits > 2000000 || excludedStructuredDataTextUnits > 2000000;
  for (const node of removals) node.remove();
  const parts: { text: string; locator?: string; table?: Table }[] = [];
  if (title) parts.push({ text: title });
  let inline = '';
  let tableNumber = 0;
  let omittedTables = 0;
  let omittedDepth = 0;
  const cellText = (node: Node, depth = 0): string => {
    if (depth > 128) {
      omittedDepth++;
      return '';
    }
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1 || (node as Element).tagName === 'TABLE') return '';
    const value = [...node.childNodes].map((child) => cellText(child, depth + 1)).join('');
    return blocks.has((node as Element).tagName) ? ` ${value} ` : value;
  };
  const flush = () => {
    const text = normalizeSpan(inline);
    if (text) parts.push({ text });
    inline = '';
  };
  const table = (element: Element, depth: number) => {
    if (depth > 128) {
      omittedDepth++;
      return;
    }
    tableNumber++;
    if (tableNumber > 80) {
      omittedTables++;
      return;
    }
    const rows = [...element.querySelectorAll('tr')].filter(
      (row) => row.closest('table') === element,
    );
    const cells: Cell[] = [];
    const grid: (number | null)[][] = [];
    const unresolved: string[] = [];
    const span = (value: string | null, remaining: number, zero: boolean) => {
      if (value === null) return 1;
      if (!/^\d+$/.test(value)) {
        unresolved.push('Invalid span attribute.');
        return 1;
      }
      const number = Number(value);
      if (zero && number === 0) return remaining;
      if (!Number.isSafeInteger(number) || number < 1 || number > 200) {
        unresolved.push('Span exceeds supported structural bounds.');
        return 1;
      }
      return number;
    };
    if (rows.length > 200) unresolved.push('Table exceeds projection bounds.');
    for (const [r, row] of rows.slice(0, 200).entries()) {
      grid[r] ??= [];
      let column = 0;
      for (const [domCell, element] of [...row.children]
        .filter((node) => ['TH', 'TD'].includes(node.tagName))
        .entries()) {
        while (grid[r][column] !== undefined) column++;
        if (column >= 64 || cells.length >= 2000) {
          unresolved.push('Cell exceeds projection bounds.');
          break;
        }
        const remaining = rows
          .slice(r)
          .filter((other) => other.parentElement === row.parentElement).length;
        const rowSpan = Math.min(
          span(element.getAttribute('rowspan'), remaining, true),
          remaining,
          200 - r,
        );
        const columnSpan = span(element.getAttribute('colspan'), 64 - column, false);
        if (column + columnSpan > 64) {
          unresolved.push('Column span exceeds projection bounds.');
          break;
        }
        const clone = element.cloneNode(true) as Element;
        for (const nested of clone.querySelectorAll('table')) nested.remove();
        const cell: Cell = {
          row: r,
          domCell,
          rowGroup: row.parentElement?.tagName.toLowerCase() ?? 'table',
          column,
          rowSpan,
          columnSpan,
          tag: element.tagName.toLowerCase(),
          text: normalizeSpan(cellText(clone)),
          headers: (element.getAttribute('headers') ?? '').split(/\s+/).filter(Boolean),
          scope: element.getAttribute('scope'),
          id: element.id || null,
          start: 0,
          end: 0,
        };
        const index = cells.length;
        cells.push(cell);
        for (let y = r; y < r + rowSpan; y++) {
          grid[y] ??= [];
          for (let x = column; x < column + columnSpan; x++) {
            if (grid[y]![x] !== undefined)
              unresolved.push('Overlapping cells; header association is unresolved.');
            else grid[y]![x] = index;
          }
        }
        column += columnSpan;
      }
    }
    const width = Math.max(0, ...grid.map((row) => row.length));
    for (const row of grid) for (let x = 0; x < width; x++) row[x] ??= null;
    let text = `[Table ${tableNumber}: generated row/column coordinates]\n`;
    const caption = [...element.children].find((node) => node.tagName === 'CAPTION');
    if (caption) text += `${normalizeSpan(caption.textContent ?? '')}\n`;
    for (const [r, row] of grid.entries()) {
      text += `Row ${r + 1}: `;
      for (const [c, index] of row.entries()) {
        if (c) text += ' | ';
        const cell = index === null ? undefined : cells[index];
        if (!cell) text += '[empty]';
        else if (cell.row !== r || cell.column !== c)
          text += `[span ${cell.row + 1},${cell.column + 1}]`;
        else {
          cell.start = text.length;
          text += cell.text;
          cell.end = text.length;
        }
      }
      text += '\n';
    }
    if (unresolved.length) {
      omittedTables++;
      text +=
        '[Unresolved table structure; original cell text follows without inferred relations]\n';
      text += rows
        .map((row) =>
          [...row.children].map((cell) => normalizeSpan(cell.textContent ?? '')).join(' | '),
        )
        .join('\n');
    }
    const projection: Table = {
      kind: 'html-table-v1',
      table: tableNumber,
      coordinate: 'UTF16-in-normalized-text',
      ordinalCoordinate: 'zero-based-DOM-row-and-cell; logical-grid-column',
      snapshotDigest: '',
      start: 0,
      end: 0,
      cells,
      grid,
      unresolved: [...new Set(unresolved)],
    };
    parts.push({
      text: text.trimEnd(),
      locator: element.id ? `#${element.id}` : `table:${tableNumber}`,
      table: projection,
    });
    // Nested tables have their own scope, rather than being flattened into outer cell values.
    for (const nested of element.querySelectorAll('table'))
      if (nested.parentElement?.closest('table') === element) table(nested, depth + 1);
  };
  const visit = (node: Node, depth = 0) => {
    if (depth > 128) {
      omittedDepth++;
      return;
    }
    if (node.nodeType === 3) {
      inline += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.tagName === 'TABLE') {
      flush();
      table(element, depth);
      return;
    }
    const block = blocks.has(element.tagName);
    if (block) flush();
    for (const child of element.childNodes) visit(child, depth + 1);
    if (block) flush();
  };
  visit(document.body);
  flush();
  let text = '';
  const sections: { locator: string; text: string; provenance: Table[] }[] = [];
  for (const part of parts) {
    if (text) text += '\n\n';
    const start = text.length;
    text += part.text;
    if (part.table) {
      part.table.start = start;
      part.table.end = text.length;
      for (const cell of part.table.cells) {
        cell.start += start;
        cell.end += start;
      }
      if (sections.length < 80)
        sections.push({ locator: part.locator!, text: part.text, provenance: [part.table] });
    }
  }
  const textDigest = digest(text);
  for (const section of sections) section.provenance[0]!.snapshotDigest = textDigest;
  return {
    text,
    sections,
    scope: {
      kind: 'html-layout-v1' as const,
      textDigest,
      projectionDigest: layoutProjectionDigest(sections),
      excludedNodes: removals.size,
      excludedContentTextUnits: Math.min(excludedContentTextUnits, 2000000),
      excludedStructuredDataTextUnits: Math.min(excludedStructuredDataTextUnits, 2000000),
      excludedTextCountOverflow,
      tables: tableNumber,
      omittedTables,
      omittedDepth,
      computedStylesEvaluated: false as const,
    },
  };
}
