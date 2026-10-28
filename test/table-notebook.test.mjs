import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerTable } from "../src/table-analysis.mjs";
import {
  createAnalysis,
  validateAnalysis,
  compileStep,
  compileChart,
  prepareAnalysisQuery,
  runAnalysisTarget,
  profileFromResults,
  chartSeries,
  buildAnalysisRun,
  validateAnalysisRun,
  exportAnalysisBundle
} from "../src/table-notebook.mjs";

const engineRoot = process.env.RESEARCH_TABLE_TEST_ENGINE_ROOT;
const makeTable = rows =>
  registerTable({
    version: "research-table-v1",
    id: `table-${randomUUID()}`,
    columns: [
      { id: "region", label: "Region", type: "text" },
      { id: "value", label: "Value", type: "number" }
    ],
    rows,
    origin: { type: "caller-supplied", label: "Synthetic notebook data" }
  });
const fixture = () => {
  const table = makeTable([
    ["east", 10],
    ["east", 20],
    ["west", 7]
  ]);
  const tables = [{ name: "sales", table }];
  const analysis = createAnalysis({
    id: "analysis-synthetic",
    title: "Regional totals",
    tables: [{ name: "sales", id: table.id, sha256: table.sha256 }],
    steps: [
      { name: "s1", sql: "SELECT c0 AS region, c1 AS amount FROM sales" },
      {
        name: "s2",
        sql: "SELECT region, SUM(amount) AS total FROM s1 GROUP BY region"
      }
    ],
    chart: null
  });
  return { table, tables, analysis };
};

test("analysis digest and ordered CTE compilation are deterministic", () => {
  const { analysis } = fixture();
  assert.equal(
    validateAnalysis(analysis).analysis_digest,
    analysis.analysis_digest
  );
  assert.equal(
    compileStep(analysis, "s2").sql,
    "WITH s1 AS (SELECT c0 AS region, c1 AS amount FROM sales), s2 AS (SELECT region, SUM(amount) AS total FROM s1 GROUP BY region) SELECT * FROM s2 LIMIT 1000"
  );
  assert.deepEqual(
    compileStep(analysis, "s1", "profile", [
      {
        id: "q0",
        label: "region",
        sql_type: "VARCHAR",
        representation: "text"
      },
      {
        id: "q1",
        label: "amount",
        sql_type: "INTEGER",
        representation: "number"
      }
    ]).parameters,
    []
  );
});

test("step admission rejects mutation, dynamic SQL, comments, params and multiple statements even when nested", () => {
  for (const sql of [
    "SELECT * FROM (WITH x AS (DELETE FROM sales RETURNING *) SELECT * FROM x)",
    "SELECT query('DELETE FROM sales')",
    "SELECT * FROM sales -- trailing",
    "SELECT * FROM sales WHERE c0=?",
    "SELECT * FROM sales; SELECT 1",
    "SELECT nextval('seq')",
    "SELECT * FROM \"read_csv_auto\"('/tmp/fixture.csv')",
    "SELECT * FROM parquet_scan('/tmp/fixture.parquet')",
    "SELECT * FROM '/tmp/fixture.parquet'"
  ])
    assert.throws(
      () =>
        createAnalysis({
          id: "analysis-bad",
          title: "Bad",
          tables: fixture().analysis.tables,
          steps: [{ name: "s1", sql }]
        }),
      /SELECT|outside|comments|parameters|semicolon|Mutating|dynamic|file-reading|procedural/u
    );
  assert.doesNotThrow(() =>
    createAnalysis({
      id: "analysis-literal",
      title: "Literal",
      tables: fixture().analysis.tables,
      steps: [{ name: "s1", sql: "SELECT 'DELETE' AS memo FROM sales" }]
    })
  );
});

test("preview binds exact datasets and chart aggregation retains exact SQL identity", () => {
  const { analysis, table, tables } = fixture();
  const preview = prepareAnalysisQuery(analysis, tables, {
    kind: "step",
    step: "s2",
    mode: "rows"
  });
  assert.equal(preview.query.sql, compileStep(analysis, "s2").sql);
  assert.equal(preview.inputs[0].sha256, table.sha256);
  const chart = createAnalysis({
    id: "analysis-chart",
    title: "Totals",
    tables: analysis.tables,
    steps: analysis.steps,
    chart: {
      mark: "bar",
      step: "s2",
      x: "q0",
      y: "q1",
      aggregate: "sum",
      series: null,
      order: "x"
    }
  });
  const query = compileChart(chart, [
    { id: "q0", label: "region", sql_type: "VARCHAR", representation: "text" },
    {
      id: "q1",
      label: "total",
      sql_type: "BIGINT",
      representation: "integer-string"
    }
  ]);
  assert.match(query.sql, /sum\("total"\)/u);
  assert.throws(
    () =>
      compileChart(chart, [
        {
          id: "q0",
          label: "region",
          sql_type: "VARCHAR",
          representation: "number"
        },
        {
          id: "q1",
          label: "total",
          sql_type: "VARCHAR",
          representation: "text"
        }
      ]),
    /Bar x|numeric|Chart/u
  );
});

test(
  "actual owner accepts CTE SELECT and blocks mutating CTE before execution",
  { skip: !engineRoot },
  async () => {
    const { analysis, tables } = fixture();
    const good = await runAnalysisTarget(
      analysis,
      tables,
      { kind: "step", step: "s1", mode: "rows" },
      { engineRoot }
    );
    assert.equal(good.status, "complete");
    assert.deepEqual(good.rows, [
      ["east", 10],
      ["east", 20],
      ["west", 7]
    ]);
    const dependent = await runAnalysisTarget(
      analysis,
      tables,
      { kind: "step", step: "s2", mode: "rows" },
      { engineRoot }
    );
    assert.equal(dependent.status, "complete");
    assert.deepEqual(dependent.rows, [
      ["east", 30],
      ["west", 7]
    ]);
    const badSql =
      "SELECT * FROM (WITH x AS (DELETE FROM sales RETURNING *) SELECT * FROM x)";
    assert.throws(
      () =>
        createAnalysis({
          id: "analysis-mutation",
          title: "Mutation",
          tables: analysis.tables,
          steps: [{ name: "s1", sql: badSql }]
        }),
      /Mutating/u
    );
  }
);

test(
  "R07 exact dataset identity survives analysis, chart result, export and offline reopen",
  { skip: !engineRoot },
  async () => {
    const table = registerTable({
      version: "research-table-v1",
      id: `table-${randomUUID()}`,
      columns: [
        { id: "c0", label: "Region", type: "text" },
        { id: "c1", label: "Amount", type: "number" }
      ],
      rows: [["east", 10], ["east", 15], ["west", 7]],
      origin: { type: "caller-supplied", label: "Synthetic R07 fixture" }
    });
    const tables = [{ name: "sales", table }];
    const analysis = createAnalysis({
      id: "analysis-r07-cold-read",
      title: "Regional totals",
      tables: [{ name: "sales", id: table.id, sha256: table.sha256 }],
      steps: [
        { name: "s1", sql: "SELECT c0 AS region, c1 AS amount FROM sales" },
        { name: "s2", sql: "SELECT region, SUM(amount) AS total FROM s1 GROUP BY region ORDER BY region" }
      ],
      chart: { mark: "bar", step: "s2", x: "q0", y: "q1", aggregate: "sum", series: null, order: "x" }
    });
    assert.equal(analysis.tables[0].sha256, table.sha256);
    const preview = prepareAnalysisQuery(analysis, tables, { kind: "step", step: "s2", mode: "rows" });
    assert.deepEqual(preview.inputs.map(input => ({ id: input.id, sha256: input.sha256 })), [{ id: table.id, sha256: table.sha256 }]);

    const first = await runAnalysisTarget(analysis, tables, { kind: "step", step: "s1", mode: "rows" }, { engineRoot });
    const second = await runAnalysisTarget(analysis, tables, { kind: "step", step: "s2", mode: "rows" }, { engineRoot });
    const chart = await runAnalysisTarget(analysis, tables, { kind: "chart", columns: second.columns }, { engineRoot });
    assert.equal(first.status, "complete");
    assert.equal(second.status, "complete");
    assert.equal(chart.status, "complete");
    assert.deepEqual(chart.rows, [["east", 25], ["west", 7]]);
    assert.deepEqual(chart.inputs.map(input => ({ id: input.id, sha256: input.sha256 })), [{ id: table.id, sha256: table.sha256 }]);
    assert.equal(chart.inputs[0].origin.type, "caller-supplied");
    assert.ok(chart.qualifications.some(item => /not independently verified evidence/u.test(item)));
    assert.ok(chart.qualifications.some(item => /does not infer row or cell lineage/u.test(item)));
    assert.ok(chart.qualifications.some(item => /Floating-point calculations may round/u.test(item)));
    assert.ok(chart.qualifications.some(item => /Reopening a retained result must not execute it again/u.test(item)));

    const entries = [
      { target: { kind: "step", step: "s1", mode: "rows" }, result: first },
      { target: { kind: "step", step: "s2", mode: "rows" }, result: second },
      { target: { kind: "chart", columns: second.columns }, result: chart }
    ];
    const run = buildAnalysisRun(analysis, entries, { id: "run-r07-cold-read" });
    const exported = exportAnalysisBundle(analysis, run);
    assert.match(exported, new RegExp(table.sha256));
    assert.match(exported, new RegExp(chart.input_digest));
    assert.match(exported, new RegExp(chart.query_digest));
    assert.match(exported, new RegExp(chart.result_sha256));
    const series = chartSeries(chart, analysis.chart);
    assert.deepEqual(series.points.map(point => [point.x, point.y]), [["east", "25"], ["west", "7"]]);

    const cold = JSON.parse(JSON.stringify(run));
    assert.deepEqual(validateAnalysisRun(cold, { analysis }), cold, "cold reopen validates embedded saved result without executing SQL");
    assert.deepEqual(validateAnalysisRun(cold, { analysis, tables }), cold, "current exact dataset identity still matches");
    const reopenedChart = cold.entries.find(entry => entry.target.kind === "chart").artifact;
    assert.deepEqual(chartSeries(reopenedChart, analysis.chart).points, series.points);

    const changedTable = registerTable({ version: "research-table-v1", id: table.id, columns: table.columns,
      rows: [["east", 999], ["east", 15], ["west", 7]], origin: table.origin });
    assert.notEqual(changedTable.sha256, table.sha256);
    assert.throws(() => validateAnalysisRun(cold, { analysis, tables: [{ name: "sales", table: changedTable }] }), /Dataset .* is missing or changed/u);
    assert.match(exported, /not independently verified evidence or confidence judgments/u);
  }
);

test(
  "profile and retained run validate offline and export exact result strings",
  { skip: !engineRoot },
  async () => {
    const { analysis, tables } = fixture();
    const rows = await runAnalysisTarget(
      analysis,
      tables,
      { kind: "step", step: "s1", mode: "rows" },
      { engineRoot }
    );
    const pquery = compileStep(analysis, "s1", "profile", rows.columns);
    const prof = await import(
      "../src/table-query.mjs"
    ).then(({ queryTables }) => queryTables(tables, pquery, { engineRoot }));
    const profile = profileFromResults(rows, prof, { analysis, step: "s1" });
    assert.equal(profile.row_count, "3");
    assert.equal(profile.columns[0].null_count, "0");
    const run = buildAnalysisRun(
      analysis,
      [{ target: { kind: "step", step: "s1", mode: "rows" }, result: rows }],
      { id: "run-synthetic" }
    );
    assert.equal(
      validateAnalysisRun(run, { analysis }).run_digest,
      run.run_digest
    );
    assert.match(exportAnalysisBundle(analysis, run), /result_sha256/u);
    const changed = structuredClone(run);
    changed.entries[0].artifact.rows[0][1] = 999;
    assert.throws(
      () => validateAnalysisRun(changed, { analysis }),
      /digest|result|run/u
    );
    const wrongTarget = structuredClone(run);
    wrongTarget.entries[0].target.step = "s2";
    assert.throws(
      () => validateAnalysisRun(wrongTarget, { analysis }),
      /compiled target|digest|query/u
    );
    const controller = new AbortController();
    controller.abort();
    const unknown = await runAnalysisTarget(
      analysis,
      tables,
      { kind: "step", step: "s1", mode: "rows" },
      { engineRoot, signal: controller.signal }
    );
    const stopped = buildAnalysisRun(
      analysis,
      [{ target: { kind: "step", step: "s1", mode: "rows" }, result: unknown }],
      { id: "run-aborted" }
    );
    assert.equal(stopped.state, "unknown");
    assert.equal(
      validateAnalysisRun(stopped, { analysis, tables }).state,
      "unknown"
    );
    const exact = createAnalysis({
      id: "analysis-exact-numbers",
      title: "Exact values",
      tables: analysis.tables,
      steps: [
        {
          name: "s1",
          sql:
            "SELECT 9007199254740993::BIGINT AS big, 1.20::DECIMAL(20,2) AS money"
        }
      ]
    });
    const exactResult = await runAnalysisTarget(
      exact,
      tables,
      { kind: "step", step: "s1", mode: "rows" },
      { engineRoot }
    );
    assert.equal(exactResult.status, "complete");
    assert.deepEqual(exactResult.rows, [["9007199254740993", "1.20"]]);
    assert.deepEqual(
      exactResult.columns.map(column => column.representation),
      ["integer-string", "decimal-string"]
    );
  }
);
