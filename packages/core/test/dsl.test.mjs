import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DslError,
  compileDsl,
  createFilesystemAdapter,
  createInMemoryAdapter,
  createJsonAdapter,
  createTypeScriptAdapter,
  formatDsl,
  fromAdapter,
  fromFilesystem,
  mountJson,
  parseDsl,
  typeScriptReplaceCall,
} from "@mirek/ast";

const node = (local, attributes) => ({
  id: { adapter: "memory", resource: "fixture", local },
  kind: "memory::item",
  attributes,
  origin: { uri: `memory:fixture#${local}`, revision: "1" },
});

const memoryEnvironment = () => {
  const adapter = createInMemoryAdapter({
    resource: { id: "fixture", adapter: "memory", uri: "memory:fixture", revision: "1" },
    roots: ["a", "b", "c"],
    nodes: [
      node("a", { name: "alpha", enabled: true, group: "one" }),
      node("b", { name: "beta", enabled: false, group: "two" }),
      node("c", { name: "gamma", enabled: true, group: "one" }),
    ],
    edges: [],
  });
  return {
    adapter,
    environment: {
      sources: {
        memory: {
          adapter,
          open: ([uri]) => fromAdapter(adapter, { uri }),
        },
      },
    },
  };
};

test("DSL parsing preserves spans and formatting is deterministic", () => {
  const source = [
    'let enabled = from memory("memory:fixture") | where @enabled = true;',
    'from memory("memory:fixture")',
    '| select \'memory::item[name ~= /a$/]\'',
    '| join enabled on @group = @group',
    '| project { left: $left.name, right: $right.name, missing: @missing }',
    "| sort left, right",
    "| take 3",
  ].join("\n");
  const program = parseDsl(source, { uri: "query.dsl" });
  assert.equal(program.range.start, 0);
  assert.equal(program.range.end, source.length);
  assert.equal(program.bindings[0]?.range.start, 0);
  assert.equal(program.pipeline.steps.flatMap(({ expressions }) => expressions).length > 0, true);
  const formatted = formatDsl(program);
  assert.equal(formatDsl(parseDsl(formatted)), formatted);
  assert.equal(formatted.includes("import"), false);
});

test("textual and programmatic queries compile to the same algebra behavior", async () => {
  const { adapter, environment } = memoryEnvironment();
  const textual = compileDsl(
    [
      'from memory("memory:fixture")',
      "| where @enabled = true",
      "| project { name: @name, uri: @origin.uri }",
      "| sort name",
      "| take 2",
    ].join("\n"),
    environment,
  );
  assert.equal(textual.kind, "query");
  const programmatic = fromAdapter(adapter, { uri: "memory:fixture" })
    .filter((value) => value.snapshot.attributes.enabled === true, "dsl where")
    .project((value) => ({
      name: value.snapshot.attributes.name,
      uri: value.snapshot.origin?.uri,
    }), "dsl project")
    .sort((left, right) => String(left.name).localeCompare(String(right.name)), "dsl sort")
    .take(2);
  assert.deepEqual(await textual.query.toArray(), await programmatic.toArray());
  assert.deepEqual(textual.query.explain(), programmatic.explain());
});

test("repository inventory and semantic transformation programs are executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ast-dsl-"));
  try {
    await writeFile(join(root, "package.json"), '{"name":"demo"}\n');
    await writeFile(join(root, "code.ts"), "oldCall(1);\n");
    const filesystem = createFilesystemAdapter();
    const json = createJsonAdapter();
    const typescript = createTypeScriptAdapter();
    const environment = {
      sources: {
        fs: {
          adapter: filesystem,
          open: ([uri]) => fromFilesystem(filesystem, {
            uri,
            include: ["package.json"],
            kinds: ["fs::file"],
          }),
        },
        ts: {
          adapter: typescript,
          open: ([uri]) => fromAdapter(typescript, { uri }),
        },
      },
      mounts: {
        json: {
          adapter: json,
          mount: (query) => mountJson(query, json),
        },
      },
      operations: {
        "ts::replace-call": {
          adapter: typescript,
          create: (target, args) =>
            typeScriptReplaceCall(target.snapshot, String(args.callee)),
        },
      },
    };

    const inventory = compileDsl(
      [
        `from fs(${JSON.stringify(root)})`,
        "| mount json",
        "| select 'json::property[name = \"name\"] > json::scalar'",
        "| project { file: @origin.uri, name: @value }",
      ].join("\n"),
      environment,
    );
    assert.equal(inventory.kind, "query");
    assert.deepEqual(await inventory.query.toArray(), [
      { file: new URL("package.json", `file://${root}/`).href, name: "demo" },
    ]);

    const transformation = compileDsl(
      [
        `from ts(${JSON.stringify(join(root, "code.ts"))})`,
        "| select 'ts::call[callee = \"oldCall\"]'",
        "| invoke ts::replace-call { callee: \"newCall\" }",
        "| plan",
      ].join("\n"),
      environment,
      { uri: "transform.dsl" },
    );
    assert.equal(transformation.kind, "plan");
    const plan = await transformation.plan();
    assert.equal(plan.changes.length, 1);
    assert.equal(await readFile(join(root, "code.ts"), "utf8"), "oldCall(1);\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bindings and equality joins remain query-algebra operations", async () => {
  const { environment } = memoryEnvironment();
  const compiled = compileDsl(
    [
      'let enabled = from memory("memory:fixture") | where @enabled = true;',
      'from memory("memory:fixture")',
      "| join enabled on @group = @group",
      "| project { left: $left.name, right: $right.name }",
      "| sort left, right",
    ].join("\n"),
    environment,
  );
  assert.equal(compiled.kind, "query");
  assert.deepEqual(await compiled.query.toArray(), [
    { left: "alpha", right: "alpha" },
    { left: "alpha", right: "gamma" },
    { left: "beta", right: undefined },
    { left: "gamma", right: "alpha" },
    { left: "gamma", right: "gamma" },
  ].filter(({ right }) => right !== undefined));

  const captured = compileDsl(
    [
      'from memory("memory:fixture")',
      "| select 'memory::item as $item'",
      "| project { name: $item.name }",
      "| take 1",
    ].join("\n"),
    environment,
  );
  assert.equal(captured.kind, "query");
  assert.deepEqual(await captured.query.toArray(), [{ name: "alpha" }]);
});

test("parse, schema, capability, and planning diagnostics retain DSL spans", async () => {
  const { adapter, environment } = memoryEnvironment();
  assert.throws(
    () => parseDsl("from memory(\"unterminated)", { uri: "bad.dsl" }),
    (error) => error instanceof DslError && error.diagnostics[0]?.locations[0]?.kind === "program",
  );
  assert.throws(
    () => compileDsl('from missing("x")', environment, { uri: "unknown.dsl" }),
    (error) => error instanceof DslError && error.diagnostics[0]?.code === "dsl.unknown-source",
  );
  assert.throws(
    () => compileDsl('from memory("memory:fixture") | select \'other::node\'', environment),
    (error) => error instanceof DslError && error.diagnostics[0]?.code === "selector.unknown-kind",
  );
  assert.throws(
    () => compileDsl('from memory("memory:fixture") | invoke memory::missing {} | plan', environment),
    (error) => error instanceof DslError && error.diagnostics[0]?.code === "dsl.unsupported-operation",
  );
  assert.throws(
    () => compileDsl('from memory("memory:fixture") | where @enabled = "yes"', environment),
    (error) => error instanceof DslError && error.diagnostics[0]?.code === "dsl.type-mismatch",
  );

  const failingAdapter = {
    ...adapter,
    planning: { async plan() { throw new Error("adapter refused plan"); } },
  };
  const planning = compileDsl(
    'from memory("memory:fixture") | invoke memory::fail {} | plan',
    {
      ...environment,
      operations: {
        "memory::fail": {
          adapter: failingAdapter,
          create: (target) => ({
            kind: "memory::fail",
            resource: target.snapshot.id.resource,
            target: target.snapshot.id,
            payload: {},
          }),
        },
      },
    },
    { uri: "planning.dsl" },
  );
  assert.equal(planning.kind, "plan");
  await assert.rejects(
    planning.plan(),
    (error) =>
      error instanceof DslError &&
      error.diagnostics[0]?.code === "dsl.planning-failed" &&
      error.diagnostics[0]?.locations[0]?.kind === "program",
  );
});
