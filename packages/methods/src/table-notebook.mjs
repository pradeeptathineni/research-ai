import { createHash, randomUUID } from "node:crypto";
import {
  prepareTableQuery,
  queryTables,
  validateTableQueryResult,
  tableQueryLimits
} from "./table-query.mjs";

const ANALYSIS = "research-table-analysis-v1",
  RUN = "research-table-analysis-run-v1";
export const tableNotebookLimits = Object.freeze({
  tables: 4,
  steps: 6,
  titleUnits: 120,
  noteUnits: 500,
  totalSqlUnits: 7600,
  bundleBytes: 4_000_000
});
const plain = v =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
const canon = v =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
    ? `[${v.map(canon).join(",")}]`
    : `{${Object.keys(v)
        .sort()
        .map(k => `${JSON.stringify(k)}:${canon(v[k])}`)
        .join(",")}}`;
const hash = v =>
  createHash("sha256")
    .update(canon(v), "utf8")
    .digest("hex");
function fail(code, msg) {
  throw Object.assign(new TypeError(msg), { code });
}
function closed(v, keys, label) {
  if (
    !plain(v) ||
    Object.getOwnPropertySymbols(v).length ||
    Object.keys(v).length !== keys.length ||
    Object.keys(v).some(
      k =>
        !keys.includes(k) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), "value")
    )
  )
    fail("invalid_input", `${label} has missing or unsupported fields.`);
}
function closedOptional(v, required, allowed, label) {
  if (
    !plain(v) ||
    Object.getOwnPropertySymbols(v).length ||
    required.some(k => !Object.hasOwn(v, k)) ||
    Object.keys(v).some(
      k =>
        !allowed.includes(k) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), "value")
    )
  )
    fail("invalid_input", `${label} has missing or unsupported fields.`);
}
function array(v, label) {
  if (
    !Array.isArray(v) ||
    Object.keys(v).length !== v.length ||
    Object.getOwnPropertySymbols(v).length ||
    Array.from({ length: v.length }, (_, i) => i).some(
      i =>
        !Object.hasOwn(
          Object.getOwnPropertyDescriptor(v, String(i)) ?? {},
          "value"
        )
    )
  )
    fail("invalid_input", `${label} must be a dense array.`);
}
const sqlName = /^[a-z][a-z0-9_]{0,31}$/u;
function validateChart(c) {
  if (c === null) return null;
  closed(
    c,
    ["mark", "step", "x", "y", "aggregate", "series", "order"],
    "chart"
  );
  if (
    !["bar", "line", "scatter"].includes(c.mark) ||
    !/^s[1-6]$/u.test(c.step) ||
    typeof c.x !== "string" ||
    !/^q\d+$/u.test(c.x) ||
    (c.y !== null && (typeof c.y !== "string" || !/^q\d+$/u.test(c.y))) ||
    !["none", "count", "sum", "avg", "min", "max"].includes(c.aggregate) ||
    (c.series !== null &&
      (typeof c.series !== "string" || !/^q\d+$/u.test(c.series))) ||
    !["x", "y-desc"].includes(c.order)
  )
    fail("chart_invalid", "Chart specification is invalid.");
  if (
    c.mark === "scatter" &&
    (c.aggregate !== "none" || c.series !== null || c.y === null)
  )
    fail(
      "chart_invalid",
      "Scatter requires x and y, no series, and aggregate none."
    );
  if (c.mark === "line" && c.y === null)
    fail("chart_invalid", "Line requires y.");
  return { ...c };
}
function scanSql(sql) {
  const words = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i],
      n = sql[i + 1];
    if (/\s/u.test(c)) {
      i++;
      continue;
    }
    if ((c === "-" && n === "-") || (c === "/" && n === "*"))
      fail(
        "invalid_step_sql",
        "SQL comments are not allowed in analysis steps."
      );
    if (
      c === "`" ||
      c === "[" ||
      c === "]" ||
      c === ";" ||
      c === "?" ||
      c === "$"
    )
      fail(
        "invalid_step_sql",
        "Quoted forms, multiple statements, and parameters are outside the supported SQL subset."
      );
    if (c === "'" || c === '"') {
      const quote = c;
      let identifier = "";
      i++;
      let closedQuote = false;
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          if (quote === '"') identifier += quote;
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          i++;
          closedQuote = true;
          break;
        }
        if (quote === '"') identifier += sql[i];
        i++;
      }
      if (!closedQuote)
        fail("invalid_step_sql", "Unterminated quoted SQL value.");
      if (quote === "'" && ["FROM", "JOIN"].includes(words.at(-1)))
        fail("invalid_step_sql", "File-reading table sources are outside the supported SQL subset.");
      if (quote === '"' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier))
        words.push(identifier.toUpperCase());
      continue;
    }
    if (/[A-Za-z_]/u.test(c)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_]/u.test(sql[i])) i++;
      words.push(sql.slice(start, i).toUpperCase());
      continue;
    }
    i++;
  }
  return words;
}
function sqlBody(v) {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    !v.isWellFormed() ||
    v.length > tableQueryLimits.sqlUnits ||
    v.includes("\0")
  )
    fail(
      "invalid_step_sql",
      "Each step must be a well-formed SQL body of at most 8,000 UTF-16 units."
    );
  const words = scanSql(v);
  if (words[0] !== "SELECT")
    fail("invalid_step_sql", "Each analysis step must begin with SELECT.");
  const blocked = new Set([
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "REPLACE",
    "CREATE",
    "DROP",
    "ALTER",
    "TRUNCATE",
    "ATTACH",
    "DETACH",
    "COPY",
    "EXPORT",
    "IMPORT",
    "INSTALL",
    "LOAD",
    "CALL",
    "EXECUTE",
    "PREPARE",
    "DEALLOCATE",
    "PRAGMA",
    "NEXTVAL",
    "SETVAL",
    "CURRVAL",
    "SETSEED",
    "QUERY",
    "QUERY_TABLE",
    "READ_CSV",
    "READ_CSV_AUTO",
    "READ_PARQUET",
    "PARQUET_SCAN",
    "PARQUET_METADATA",
    "PARQUET_SCHEMA",
    "READ_JSON",
    "READ_JSON_AUTO",
    "READ_NDJSON",
    "READ_NDJSON_AUTO",
    "CSV_SCAN",
    "JSON_SCAN",
    "READ_TEXT",
    "READ_BLOB",
    "GLOB"
  ]);
  if (words.some(word => blocked.has(word)))
    fail(
      "invalid_step_sql",
      "Mutating, dynamic, file-reading, or procedural SQL is outside the supported SELECT subset."
    );
  return v.trim();
}
/** Validate and digest an immutable table-analysis revision. */
export function validateAnalysis(value) {
  closed(
    value,
    [
      "version",
      "id",
      "revision",
      "parent_digest",
      "title",
      "tables",
      "steps",
      "chart",
      "analysis_digest"
    ],
    "analysis"
  );
  if (
    value.version !== ANALYSIS ||
    typeof value.id !== "string" ||
    !/^analysis-[A-Za-z0-9-]{1,60}$/u.test(value.id) ||
    !Number.isInteger(value.revision) ||
    value.revision < 1 ||
    !(
      value.parent_digest === null ||
      /^[a-f0-9]{64}$/u.test(value.parent_digest)
    ) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > tableNotebookLimits.titleUnits
  )
    fail("invalid_analysis", "Analysis identity or title is invalid.");
  array(value.tables, "tables");
  array(value.steps, "steps");
  if (
    !value.tables.length ||
    value.tables.length > tableNotebookLimits.tables ||
    !value.steps.length ||
    value.steps.length > tableNotebookLimits.steps
  )
    fail(
      "limit_exceeded",
      "Use one through four tables and one through six steps."
    );
  const names = new Set(),
    tables = value.tables.map(t => {
      closed(t, ["name", "id", "sha256"], "table reference");
      if (
        typeof t.name !== "string" ||
        !sqlName.test(t.name) ||
        names.has(t.name) ||
        typeof t.id !== "string" ||
        !/^table-[0-9a-f-]{36}$/u.test(t.id) ||
        typeof t.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(t.sha256)
      )
        fail(
          "invalid_analysis",
          "Table references must have unique names and exact identities."
        );
      names.add(t.name);
      return { ...t };
    });
  let total = 0;
  const steps = value.steps.map((s, i) => {
    const keys = Object.keys(s ?? {});
    if (
      keys.some(k => !["name", "sql", "note"].includes(k)) ||
      !Object.hasOwn(s, "name") ||
      !Object.hasOwn(s, "sql")
    )
      fail("invalid_step", "Step has unsupported fields.");
    const expected = `s${i + 1}`;
    if (s.name !== expected || names.has(s.name))
      fail(
        "invalid_step",
        "Steps must be ordered s1 through s6 and cannot collide with table names."
      );
    names.add(s.name);
    const sql = sqlBody(s.sql);
    total += sql.length;
    if (
      s.note !== undefined &&
      (typeof s.note !== "string" ||
        s.note.length > tableNotebookLimits.noteUnits)
    )
      fail("invalid_step", "Step note is too long.");
    return {
      name: s.name,
      sql,
      ...(s.note === undefined ? {} : { note: s.note })
    };
  });
  if (total > tableNotebookLimits.totalSqlUnits)
    fail(
      "limit_exceeded",
      "Step SQL exceeds the 7,600-unit compiled-SQL budget."
    );
  for (const [index, step] of steps.entries()) {
    for (const token of scanSql(step.sql)) {
      const referenced = /^S([1-6])$/u.exec(token);
      if (referenced && Number(referenced[1]) >= index + 1) {
        fail(
          "invalid_dependency",
          `Step ${step.name} cannot reference itself or later step s${referenced[1]}.`
        );
      }
    }
  }
  const chart = validateChart(value.chart);
  if (chart && !steps.some(s => s.name === chart.step))
    fail("chart_invalid", "Chart step is missing.");
  const core = {
    version: ANALYSIS,
    id: value.id,
    revision: value.revision,
    parent_digest: value.parent_digest,
    title: value.title,
    tables,
    steps,
    chart
  };
  const analysis_digest = hash(core);
  if (value.analysis_digest !== analysis_digest)
    fail(
      "analysis_digest_mismatch",
      "Analysis digest does not match its contents."
    );
  return { ...core, analysis_digest };
}
/** Create revision 1 from selected registered table references and ordered SQL steps. */
export function createAnalysis({
  id = `analysis-${randomUUID()}`,
  revision = 1,
  parent_digest = null,
  title,
  tables,
  steps,
  chart = null
}) {
  const core = {
    version: ANALYSIS,
    id,
    revision,
    parent_digest,
    title,
    tables,
    steps,
    chart
  };
  return validateAnalysis({ ...core, analysis_digest: hash(core) });
}
function tableBindings(analysis, tables) {
  array(tables, "registered tables");
  const byName = new Map(tables.map(x => [x.name, x]));
  if (byName.size !== analysis.tables.length)
    fail(
      "dataset_version_missing",
      "All selected exact datasets must be supplied."
    );
  for (const ref of analysis.tables) {
    const b = byName.get(ref.name);
    if (!b || b.table.id !== ref.id || b.table.sha256 !== ref.sha256)
      fail(
        "dataset_version_missing",
        `Dataset ${ref.name} is missing or changed.`
      );
  }
  return analysis.tables.map(t => byName.get(t.name));
}
function ctes(analysis, upto) {
  const parts = analysis.steps
    .slice(0, upto + 1)
    .map(s => `${s.name} AS (${s.sql})`);
  return `WITH ${parts.join(", ")} `;
}
function colId(label) {
  const n = Number(/^q(\d+)$/u.exec(label)?.[1]);
  if (!Number.isSafeInteger(n) || n < 0 || n > 31)
    fail("chart_invalid", "Column identity is invalid.");
  return `q${n}`;
}
/** Compile a step inspection into one read-only SELECT; no engine starts. */
export function compileStep(
  analysisValue,
  stepName,
  mode = "rows",
  resultColumns = []
) {
  const a = validateAnalysis(analysisValue),
    i = a.steps.findIndex(s => s.name === stepName);
  if (i < 0 || !["rows", "profile"].includes(mode))
    fail("invalid_target", "Step target or mode is invalid.");
  const prefix = ctes(a, i);
  let sql;
  if (mode === "rows") sql = `${prefix}SELECT * FROM ${stepName} LIMIT 1000`;
  else {
    array(resultColumns, "result columns");
    if (resultColumns.length > 31)
      fail("limit_exceeded", "At most 31 columns can receive a null profile.");
    const cols = resultColumns.map((c, i) => {
      closed(c, ["id", "label", "sql_type", "representation"], "result column");
      if (c.id !== `q${i}` || typeof c.label !== "string")
        fail("invalid_profile", "Column mapping is invalid.");
      return `count("${c.label.replaceAll('"', '""')}") AS nn_${c.id}`;
    });
    sql = `${prefix}SELECT count(*) AS n${
      cols.length ? `, ${cols.join(", ")}` : ""
    } FROM ${stepName}`;
  }
  if (sql.length > tableQueryLimits.sqlUnits)
    fail("limit_exceeded", "Compiled SQL exceeds 8,000 UTF-16 units.");
  return { sql, parameters: [] };
}
/** Compile a chart aggregation as SQL so the exact computation is digest-bound. */
export function compileChart(analysisValue, resultColumns) {
  const a = validateAnalysis(analysisValue),
    c = a.chart;
  if (!c) fail("chart_invalid", "Analysis has no chart specification.");
  array(resultColumns, "result columns");
  const i = a.steps.findIndex(s => s.name === c.step);
  if (i < 0) fail("chart_invalid", "Chart step is missing.");
  const cols = new Map(resultColumns.map(x => [x.id, x]));
  const x = cols.get(c.x),
    y = c.y === null ? null : cols.get(c.y),
    series = c.series === null ? null : cols.get(c.series);
  if (!x || (c.y !== null && !y) || (c.series !== null && !series))
    fail("chart_invalid", "Chart column is absent from inspected result.");
  const numeric = v =>
    v &&
    ["number", "integer-string", "decimal-string"].includes(v.representation);
  if (c.mark === "scatter" && (!numeric(x) || !numeric(y)))
    fail("chart_invalid", "Scatter axes must be numeric.");
  if (
    c.mark === "line" &&
    !numeric(x) &&
    x.representation !== "temporal-string"
  )
    fail("chart_invalid", "Line x must be numeric or temporal.");
  if (
    c.mark === "bar" &&
    !["text", "boolean", "temporal-string"].includes(x.representation)
  )
    fail("chart_invalid", "Bar x must be text, boolean, or temporal.");
  if (c.mark !== "scatter" && c.aggregate === "none")
    fail(
      "chart_invalid",
      "Bar and line charts require an explicit aggregate in this slice."
    );
  if (c.aggregate !== "count" && c.y === null && c.mark !== "scatter")
    fail("chart_invalid", "This aggregate requires y.");
  if (c.aggregate !== "count" && c.mark !== "scatter" && !numeric(y))
    fail("chart_invalid", "Chart y must be safely numeric.");
  if (c.mark === "bar" && c.order === "y-desc" && c.aggregate === "none")
    fail("chart_invalid", "y-desc requires an aggregate.");
  if (c.series && c.mark === "scatter")
    fail("chart_invalid", "Scatter charts do not accept a series.");
  const ident = v => '"' + v.label.replaceAll('"', '""') + '"';
  if (c.mark === "scatter")
    return {
      sql: `${ctes(a, i)}SELECT ${ident(x)}, ${ident(y)} FROM ${
        c.step
      } ORDER BY ${ident(x)} LIMIT 1000`,
      parameters: []
    };
  const group = [ident(x), ...(series ? [ident(series)] : [])],
    metric =
      c.aggregate === "count"
        ? "count(*)"
        : c.aggregate === "none"
        ? ident(y)
        : `${c.aggregate}(${ident(y)})`,
    alias = '"chart_value"';
  let sql = `${ctes(a, i)}SELECT ${group.join(
    ", "
  )}, ${metric} AS ${alias} FROM ${c.step} GROUP BY ${group.join(", ")}`;
  sql +=
    c.mark === "line"
      ? ` ORDER BY ${ident(x)}`
      : c.order === "y-desc"
      ? ` ORDER BY ${alias} DESC`
      : ` ORDER BY ${ident(x)}`;
  if (sql.length > tableQueryLimits.sqlUnits)
    fail("limit_exceeded", "Compiled chart SQL exceeds 8,000 units.");
  return { sql, parameters: [] };
}
/** Preview exact source bindings, compiled SQL and query digests. */
export function prepareAnalysisQuery(analysisValue, tables, target) {
  const a = validateAnalysis(analysisValue),
    bindings = tableBindings(a, tables);
  let query;
  if (target?.kind === "step")
    query = compileStep(a, target.step, target.mode, target.columns ?? []);
  else if (target?.kind === "chart") {
    if (!a.chart) fail("chart_invalid", "Analysis has no chart.");
    query = compileChart(a, target.columns ?? []);
  } else fail("invalid_target", "Target must be a step inspection or chart.");
  return {
    ...prepareTableQuery(bindings, query),
    target: { ...target },
    analysis_digest: a.analysis_digest
  };
}
/** Execute one compiled target with the existing isolated SELECT owner. */
export async function runAnalysisTarget(
  analysisValue,
  tables,
  target,
  options
) {
  const a = validateAnalysis(analysisValue),
    bindings = tableBindings(a, tables);
  let query;
  if (target.kind === "step")
    query = compileStep(a, target.step, target.mode, target.columns ?? []);
  else if (target.kind === "chart") query = compileChart(a, target.columns);
  else fail("invalid_target", "Unknown target.");
  return queryTables(bindings, query, options);
}
/** Summarize owner-produced rows and profile without claiming inferential quality. */
export function profileFromResults(
  rowsResult,
  profileResult,
  { analysis, step } = {}
) {
  const a = validateAnalysis(analysis);
  const rows = validateTableQueryResult(rowsResult),
    profile = validateTableQueryResult(profileResult);
  if (
    !a.steps.some(s => s.name === step) ||
    hash(rows.query) !== hash(compileStep(a, step, "rows")) ||
    hash(profile.query) !== hash(compileStep(a, step, "profile", rows.columns))
  )
    fail(
      "profile_mismatch",
      "Rows or profile query does not match the exact inspected step."
    );
  if (
    rowsResult.inputs.length !== profileResult.inputs.length ||
    rowsResult.inputs.some(
      (x, i) => x.sha256 !== profileResult.inputs[i]?.sha256
    )
  )
    fail(
      "profile_mismatch",
      "Profile and rows are from different selected inputs."
    );
  const r = profile.rows[0] ?? [];
  const exact = v => (v === null ? null : String(v));
  const total = exact(r[0]);
  const columnProfiles = rows.columns.map((c, i) => {
    const nonnull = i + 1 < r.length ? exact(r[i + 1]) : null;
    let nullCount = null;
    if (total !== null && nonnull !== null) {
      try {
        nullCount = (BigInt(total) - BigInt(nonnull)).toString();
      } catch {
        nullCount = null;
      }
    }
    return {
      id: c.id,
      label: c.label,
      sql_type: c.sql_type,
      representation: c.representation,
      null_count: nullCount,
      profiled: i + 1 < r.length,
      flags: nonnull === "0" && total !== "0" ? ["all_null"] : []
    };
  });
  return {
    row_count: total,
    columns: columnProfiles,
    qualifications: ["Counts are retained as exact decimal strings."]
  };
}
/** Turn chart rows into exact-text points; downstream visualizers decide pixel placement. */
export function chartSeries(chartResult, spec) {
  const result = validateTableQueryResult(chartResult),
    rows = result.rows;
  const exact = v => (v === null ? null : String(v));
  const excluded =
    spec.mark === "scatter" ? 0 : rows.filter(r => r.at(-1) === null).length;
  if (spec.series) {
    const distinct = new Set(
      rows.map(r => (r[1] === null ? "(null)" : String(r[1])))
    );
    if (distinct.size > 8)
      fail(
        "chart_invalid",
        "A chart series may contain at most eight distinct values."
      );
  }
  return {
    points: rows
      .filter(r => spec.mark === "scatter" || r.at(-1) !== null)
      .map(r => ({
        x: exact(r[0]),
        ...(spec.series ? { series: exact(r[1]) } : {}),
        y: exact(r.at(-1))
      })),
    caption: `${spec.aggregate} by ${spec.x} — ${rows.length -
      excluded} groups, ${excluded} null values excluded.`,
    disclosures: [
      ...(spec.mark === "scatter"
        ? ["Shows co-occurrence in these rows; it does not show cause."]
        : []),
      ...(result.rows.length >= 1000 ? ["Shows at most 1,000 rows."] : [])
    ]
  };
}
function targetKey(t) {
  return t.kind === "step" ? `step:${t.step}:${t.mode}` : "chart";
}
function targetQuery(a, t, priorRows) {
  if (!plain(t) || !["step", "chart"].includes(t.kind))
    fail("invalid_target", "Invalid run target.");
  if (t.kind === "step") {
    closedOptional(
      t,
      ["kind", "step", "mode"],
      ["kind", "step", "mode", "columns"],
      "step target"
    );
    if (t.mode === "rows") return compileStep(a, t.step, "rows");
    if (t.mode === "profile") {
      const prior = priorRows.get(t.step);
      if (!prior)
        fail(
          "invalid_target",
          "Profile target requires a preceding completed rows target."
        );
      if (t.columns && hash(t.columns) !== hash(prior.columns))
        fail(
          "invalid_target",
          "Profile columns must come from the preceding rows result."
        );
      return compileStep(a, t.step, "profile", prior.columns);
    }
    fail("invalid_target", "Unknown step inspection mode.");
  }
  if (
    Object.keys(t).some(k => !["kind", "columns"].includes(k)) ||
    !Array.isArray(t.columns)
  )
    fail("invalid_target", "Chart target requires its inspected step columns.");
  const chartStep = a.chart?.step,
    prior = priorRows.get(chartStep);
  if (!prior || hash(t.columns) !== hash(prior.columns))
    fail(
      "invalid_target",
      "Chart target columns must come from a preceding rows inspection of the chart step."
    );
  return compileChart(a, t.columns);
}
function inputRefsMatch(inputs, analysis) {
  return (
    Array.isArray(inputs) &&
    inputs.length === analysis.tables.length &&
    analysis.tables.every(
      (ref, i) =>
        inputs[i]?.name === ref.name &&
        inputs[i]?.id === ref.id &&
        inputs[i]?.sha256 === ref.sha256
    )
  );
}
function expectedInputDigest(a, tables) {
  return tables
    ? prepareTableQuery(tableBindings(a, tables), {
        sql: "SELECT 1",
        parameters: []
      }).input_digest
    : null;
}
/** Build immutable run evidence from captured owner responses only. */
export function buildAnalysisRun(
  analysisValue,
  entries,
  { id = randomUUID() } = {}
) {
  const a = validateAnalysis(analysisValue);
  array(entries, "run entries");
  let state = "complete",
    halted = false;
  const built = [],
    priorRows = new Map(),
    seen = new Set();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    closed(entry, ["target", "result"], "run entry input");
    const t = entry.target,
      k = targetKey(t);
    if (seen.has(k))
      fail("invalid_target", "A run target may appear only once.");
    seen.add(k);
    const query = targetQuery(a, t, priorRows),
      result = entry.result;
    let base = {
      target: t,
      state: result.status,
      query_digest: result.query_digest
    };
    if (halted) {
      built.push({ ...base, state: "not_started" });
      continue;
    }
    if (result.query_digest !== hash(query))
      fail(
        "run_digest_mismatch",
        "Captured query digest does not match its compiled target."
      );
    if (result.status === "complete") {
      const checked = validateTableQueryResult(result);
      if (
        hash(checked.query) !== hash(query) ||
        !inputRefsMatch(checked.inputs, a)
      )
        fail(
          "run_input_mismatch",
          "Captured result query or source identities differ from this analysis."
        );
      base = {
        ...base,
        state: "complete",
        result_sha256: checked.result_sha256,
        artifact: checked
      };
      if (t.kind === "step" && t.mode === "rows")
        priorRows.set(t.step, checked);
    } else if (result.status === "failed") {
      halted = true;
      state = built.some(x => x.state === "complete") ? "halted" : "failed";
      base = {
        ...base,
        state: "failed",
        input_digest: result.input_digest,
        error: result.error
      };
    } else if (result.status === "unknown") {
      halted = true;
      state = built.some(x => x.state === "complete") ? "halted" : "unknown";
      base = {
        ...base,
        state: "unknown",
        input_digest: result.input_digest,
        reason: result.reason
      };
    } else fail("invalid_run", "Captured result has an invalid state.");
    built.push(base);
  }
  const content = {
    version: RUN,
    id,
    analysis_digest: a.analysis_digest,
    state,
    entries: built
  };
  return { ...content, run_digest: hash(content) };
}
/** Offline integrity validation; with source tables it also rebinds exact source versions. */
export function validateAnalysisRun(run, { analysis, tables } = {}) {
  closed(
    run,
    ["version", "id", "analysis_digest", "state", "entries", "run_digest"],
    "analysis run"
  );
  const a = validateAnalysis(analysis);
  if (
    run.version !== RUN ||
    run.analysis_digest !== a.analysis_digest ||
    !["complete", "failed", "unknown", "halted", "interrupted"].includes(
      run.state
    )
  )
    fail("invalid_run", "Run binding or state is invalid.");
  array(run.entries, "run entries");
  let halted = false,
    priorRows = new Map(),
    completed = 0,
    observedState = "complete";
  const seen = new Set();
  for (const e of run.entries) {
    closedOptional(
      e,
      ["target", "state", "query_digest"],
      [
        "target",
        "state",
        "query_digest",
        "result_sha256",
        "artifact",
        "input_digest",
        "error",
        "reason"
      ],
      "run entry"
    );
    const k = targetKey(e.target);
    if (seen.has(k)) fail("invalid_run", "Duplicate run target.");
    seen.add(k);
    const query = targetQuery(a, e.target, priorRows);
    if (e.query_digest !== hash(query))
      fail(
        "run_digest_mismatch",
        "Saved target query digest does not match the compiled target."
      );
    if (e.state === "complete") {
      if (halted || !e.artifact || e.result_sha256 !== e.artifact.result_sha256)
        fail(
          "invalid_run",
          "Completed target appears after a stop or lacks its result."
        );
      const r = validateTableQueryResult(
        e.artifact,
        tables ? { tables: tableBindings(a, tables) } : {}
      );
      if (
        r.query_digest !== e.query_digest ||
        hash(r.query) !== hash(query) ||
        !inputRefsMatch(r.inputs, a)
      )
        fail(
          "run_input_mismatch",
          "Retained result is not bound to this exact analysis and query."
        );
      if (e.input_digest !== undefined && e.input_digest !== r.input_digest)
        fail("run_digest_mismatch", "Input digest changed.");
      if (e.target.kind === "step" && e.target.mode === "rows")
        priorRows.set(e.target.step, r);
      completed++;
    } else if (e.state === "failed" || e.state === "unknown") {
      if (
        halted ||
        typeof e.input_digest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(e.input_digest)
      )
        fail(
          "invalid_run",
          "Failure state is malformed or follows another stop."
        );
      halted = true;
      observedState = completed ? "halted" : e.state;
      if (
        (e.state === "failed" && typeof e.error !== "string") ||
        (e.state === "unknown" &&
          !["deadline", "aborted", "worker_cleanup_unconfirmed"].includes(
            e.reason
          ))
      )
        fail("invalid_run", "Failure detail is invalid.");
      if (tables && e.input_digest !== expectedInputDigest(a, tables))
        fail(
          "run_input_mismatch",
          "Failed target input digest differs from the exact source tables."
        );
    } else if (e.state === "not_started") {
      if (!halted || e.artifact !== undefined || e.input_digest !== undefined)
        fail(
          "invalid_run",
          "Not-started target lacks a prior stop or contains results."
        );
    } else fail("invalid_run", "Entry state is invalid.");
  }
  if (
    run.state !== observedState &&
    !(run.state === "interrupted" && observedState === "complete")
  )
    fail("invalid_run", "Run-level state does not match its entries.");
  const { run_digest, ...content } = run;
  if (run_digest !== hash(content))
    fail("run_digest_mismatch", "Run digest does not match.");
  return structuredClone(run);
}
/** Export analysis and run evidence in a bounded, deterministic bundle. */
export function exportAnalysisBundle(analysisValue, run, options = {}) {
  if (
    !plain(options) ||
    Object.getOwnPropertySymbols(options).length ||
    Object.keys(options).some(
      k =>
        k !== "includeSourceRows" ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(options, k), "value")
    )
  )
    fail("invalid_options", "Export options are invalid.");
  if (
    options.includeSourceRows !== undefined &&
    typeof options.includeSourceRows !== "boolean"
  )
    fail("invalid_options", "includeSourceRows must be boolean.");
  if (options.includeSourceRows)
    fail(
      "unsupported_export",
      "Source rows are excluded in this export slice."
    );
  const a = validateAnalysis(analysisValue),
    r = validateAnalysisRun(run, { analysis: a });
  const bundle = {
    version: "research-table-analysis-bundle-v1",
    analysis: a,
    run: r,
    qualifications: [
      "Analysis steps use the owner’s conservative SELECT subset and run only over explicitly supplied registered datasets.",
      "A query digest binds exact inputs and SQL; it does not prove source truth or infer row/cell lineage.",
      "Exact integer and decimal results remain strings in retained results and exports."
    ]
  };
  const text = JSON.stringify(bundle, null, 2);
  if (Buffer.byteLength(text) > tableNotebookLimits.bundleBytes)
    fail("limit_exceeded", "Analysis bundle exceeds 4 MB.");
  return text + "\n";
}
