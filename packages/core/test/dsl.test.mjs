import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  selectFrom,
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
          selectorSource: "roots",
          arguments: {
            uri: { type: "string", cardinality: "one", required: true },
          },
          open: (args) => fromAdapter(adapter, { uri: args.uri }),
        },
      },
    },
  };
};

test("DSL parsing preserves spans and formatting is deterministic", () => {
  const source = [
    'let enabled = from memory({ uri: "memory:fixture" }) | where @enabled = true;',
    'from memory({ uri: "memory:fixture" })',
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
      'from memory({ uri: "memory:fixture" })',
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
          selectorSource: "selection",
          arguments: {
            uri: { type: "string", cardinality: "one", required: true },
          },
          open: (args) => fromFilesystem(filesystem, {
            uri: args.uri,
            include: ["package.json"],
            kinds: ["fs::file"],
          }),
        },
        ts: {
          adapter: typescript,
          selectorSource: "roots",
          arguments: {
            uri: { type: "string", cardinality: "one", required: true },
          },
          open: (args) => fromAdapter(typescript, { uri: args.uri }),
        },
      },
      mounts: {
        json: {
          adapter: json,
          arguments: {},
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
        `from fs({ uri: ${JSON.stringify(root)} })`,
        "| mount json()",
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
        `from ts({ uri: ${JSON.stringify(join(root, "code.ts"))} })`,
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

test("filesystem stream selectors match an explicitly scoped TypeScript query", async () => {
  const root = await mkdtemp(join(tmpdir(), "ast-dsl-fs-selector-"));
  try {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "root.ts"), "export {};\n");
    await writeFile(join(root, "nested", "nested.ts"), "export {};\n");
    await writeFile(join(root, "root.json"), "{\"value\":1}\n");
    await writeFile(join(root, "nested", "nested.json"), "{\"value\":2}\n");
    const filesystem = createFilesystemAdapter();
    const source = () => fromFilesystem(filesystem, { uri: root });
    const selector = 'fs::file[extension = ".ts"]';
    const textual = compileDsl(
      `from fs({ uri: ${JSON.stringify(root)} }) | select '${selector}'`,
      {
        sources: {
          fs: {
            adapter: filesystem,
            selectorSource: "selection",
            arguments: {
              uri: { type: "string", cardinality: "one", required: true },
            },
            open: source,
          },
        },
      },
    );
    const programmatic = selectFrom(source(), filesystem.schema, selector, {
      sourceMode: "selection",
    });

    assert.equal(textual.kind, "query");
    assert.deepEqual(
      await textual.query.project((value) => value.snapshot.attributes.path).toArray(),
      ["nested/nested.ts", "root.ts"],
    );
    assert.deepEqual(textual.query.explain(), programmatic.explain());

    const json = createJsonAdapter();
    const jsonSource = () => fromFilesystem(filesystem, {
      uri: root,
      include: ["**/*.json"],
      kinds: ["fs::file"],
    });
    const mountedEnvironment = {
      sources: {
        fs: {
          adapter: filesystem,
          selectorSource: "selection",
          arguments: {
            uri: { type: "string", cardinality: "one", required: true },
          },
          open: jsonSource,
        },
      },
      mounts: {
        json: {
          adapter: json,
          arguments: {},
          mount: (query) => mountJson(query, json),
        },
      },
    };
    const filesOnly = compileDsl(
      `from fs({ uri: ${JSON.stringify(root)} }) | mount json() | select 'fs::file'`,
      mountedEnvironment,
    );
    assert.equal(filesOnly.kind, "query");
    assert.equal(json.statistics().filesRead, 0);
    assert.equal((await filesOnly.query.toArray()).length, 2);
    assert.equal(json.statistics().filesRead, 0);

    const mountedSelector = "fs::file > json::root json::scalar";
    const mountedTextual = compileDsl(
      `from fs({ uri: ${JSON.stringify(root)} }) | mount json() | select '${mountedSelector}'`,
      mountedEnvironment,
    );
    const mountedProgrammatic = selectFrom(
      mountJson(jsonSource(), json),
      [filesystem.schema, json.schema],
      mountedSelector,
    );
    assert.equal(mountedTextual.kind, "query");
    assert.deepEqual(
      await mountedTextual.query.project((value) => value.snapshot.attributes.value).toArray(),
      [2, 1],
    );
    assert.deepEqual(mountedTextual.query.explain(), mountedProgrammatic.explain());
    assert.match(JSON.stringify(mountedTextual.query.explain()), /fs -> json/);

    for (const [selectorSource, code, schema, fragment] of [
      ["fs::missing > json::root", "selector.unknown-kind", "schema fs", "fs::missing"],
      ["fs::file ->json::missing json::root", "selector.unknown-edge", "schema json", "json::missing"],
      ["fs::file > json::root[missing = 1]", "selector.unknown-attribute", "schema json", "missing = 1"],
    ]) {
      const sourceText = `from fs({ uri: ${JSON.stringify(root)} }) | mount json() | select '${selectorSource}'`;
      assert.throws(
        () => compileDsl(
          sourceText,
          mountedEnvironment,
          { uri: "mounted.dsl" },
        ),
        (error) => {
          assert.equal(error instanceof DslError, true);
          assert.equal(error.diagnostics[0].code, code);
          assert.match(error.diagnostics[0].message, new RegExp(schema));
          const range = error.diagnostics[0].locations[0].range;
          assert.match(sourceText.slice(range.start, range.end), new RegExp(fragment));
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source and mount argument schemas resolve named scalars, arrays, and defaults", async () => {
  const { adapter } = memoryEnvironment();
  let opened;
  let mounted;
  const environment = {
    sources: {
      memory: {
        adapter,
        selectorSource: "roots",
        arguments: {
          uri: { type: "string", cardinality: "one", required: true },
          tags: { type: "string", cardinality: "many", required: false },
          enabled: {
            type: "boolean",
            cardinality: "one",
            required: false,
            default: true,
          },
          token: {
            type: "string",
            cardinality: "one",
            required: false,
            sensitive: true,
          },
        },
        open: (options) => {
          opened = options;
          return fromAdapter(adapter, { uri: options.uri });
        },
      },
    },
    mounts: {
      passthrough: {
        adapter,
        arguments: {
          mode: {
            type: "string",
            cardinality: "one",
            required: true,
            choices: ["safe"],
          },
          policy: {
            type: "string",
            cardinality: "one",
            required: false,
            default: "skip",
            choices: ["skip", "throw"],
          },
        },
        mount: (query, options) => {
          mounted = options;
          return query;
        },
      },
    },
  };
  const compiled = compileDsl(
    'from memory({ uri: "memory:fixture", tags: ["one", "two"], token: "DO-NOT-LEAK" }) | mount passthrough({ mode: "safe", policy: "throw" }) | count',
    environment,
  );

  assert.equal(compiled.kind, "query");
  assert.deepEqual(opened, {
    uri: "memory:fixture",
    tags: ["one", "two"],
    enabled: true,
    token: "DO-NOT-LEAK",
  });
  assert.equal(Object.isFrozen(opened), true);
  assert.equal(Object.isFrozen(opened.tags), true);
  assert.deepEqual(mounted, { mode: "safe", policy: "throw" });
  assert.deepEqual(await compiled.query.toArray(), [3]);
  assert.equal(JSON.stringify(compiled.query.explain()).includes("DO-NOT-LEAK"), false);

  const invalid = [
    ['from memory({ tags: ["one"] })', "dsl.missing-argument"],
    ['from memory({ uri: "memory:fixture", extra: true })', "dsl.unknown-argument"],
    ['from memory({ uri: ["memory:fixture"] })', "dsl.argument-cardinality"],
    ['from memory({ uri: 1 })', "dsl.argument-type"],
    ['from memory("memory:fixture")', "dsl.expected-arguments"],
    [
      'from memory({ uri: "memory:fixture" }) | mount passthrough({ mode: "safe", policy: "other" })',
      "dsl.argument-choice",
    ],
    [
      'from memory({ uri: "first", uri: "second" })',
      "dsl.duplicate-argument",
    ],
    [
      'from memory({ uri: "memory:fixture" }) | mount passthrough({ mode: "safe", extra: true })',
      "dsl.unknown-argument",
    ],
    [
      'from memory({ uri: "memory:fixture" }) | mount passthrough({})',
      "dsl.missing-argument",
    ],
  ];
  for (const [program, code] of invalid) {
    assert.throws(
      () => compileDsl(program, environment, { uri: "arguments.dsl" }),
      (error) => {
        assert(error instanceof DslError);
        assert.equal(error.diagnostics[0]?.code, code);
        assert.equal(error.diagnostics[0]?.locations[0]?.uri, "arguments.dsl");
        assert.equal(error.diagnostics[0]?.locations[0]?.range?.start >= 0, true);
        return true;
      },
    );
  }
});

test("bindings and equality joins remain query-algebra operations", async () => {
  const { environment } = memoryEnvironment();
  const compiled = compileDsl(
    [
      'let enabled = from memory({ uri: "memory:fixture" }) | where @enabled = true;',
      'from memory({ uri: "memory:fixture" })',
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
      'from memory({ uri: "memory:fixture" })',
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
    () => compileDsl('from missing({ uri: "x" })', environment, { uri: "unknown.dsl" }),
    (error) => error instanceof DslError && error.diagnostics[0]?.code === "dsl.unknown-source",
  );
  assert.throws(
    () => compileDsl('from memory({ uri: "memory:fixture" }) | select \'other::node\'', environment),
    (error) => error instanceof DslError && error.diagnostics[0]?.code === "selector.unknown-kind",
  );
  assert.throws(
    () => compileDsl('from memory({ uri: "memory:fixture" }) | invoke memory::missing {} | plan', environment),
    (error) => error instanceof DslError && error.diagnostics[0]?.code === "dsl.unsupported-operation",
  );
  assert.throws(
    () => compileDsl('from memory({ uri: "memory:fixture" }) | where @enabled = "yes"', environment),
    (error) => error instanceof DslError && error.diagnostics[0]?.code === "dsl.type-mismatch",
  );

  const failingAdapter = {
    ...adapter,
    planning: { async plan() { throw new Error("adapter refused plan"); } },
  };
  const planning = compileDsl(
    'from memory({ uri: "memory:fixture" }) | invoke memory::fail {} | plan',
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
