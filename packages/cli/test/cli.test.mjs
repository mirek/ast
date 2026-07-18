import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const core = fileURLToPath(new URL("../../core/dist/index.js", import.meta.url));

const fixture = async (run) => {
  const root = await mkdtemp(join(tmpdir(), "ast-cli-"));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
};

const run = async (args, options = {}) => {
  if (options.input !== undefined) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: options.cwd,
        env: { ...process.env, NO_COLOR: "1", ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (value) => { stdout += value; });
      child.stderr.on("data", (value) => { stderr += value; });
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.end(options.input);
    });
  }
  try {
    const result = await execute(process.execPath, [cli, ...args], {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1", ...options.env },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
};

const resignPlanEnvelope = (envelope) => {
  const body = JSON.stringify(envelope.plan);
  envelope.integrity = `sha256:${createHash("sha256").update(body).digest("base64url")}`;
  return envelope;
};

test("explicit file, expression, and stdin modes keep truthful locations", async () =>
  fixture(async (root) => {
    const data = join(root, "input.json");
    const program = join(root, "input.dsl");
    const source = `from json({ uri: ${JSON.stringify(data)} }) | select 'json::scalar'`;
    await writeFile(data, '{"value":1}\n');
    await writeFile(program, source);

    const file = await run(["query", "--file", program]);
    const expression = await run(["query", "--expr", source]);
    const stdin = await run(["query", "--stdin"], { input: source });
    assert.equal(file.code, 0);
    assert.deepEqual(expression, file);
    assert.deepEqual(stdin, file);

    const missing = await run(["query", join(root, "missing.dsl")]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /missing\.dsl/);
    assert.doesNotMatch(missing.stderr, /dsl\.(?:invalid|expected)/);

    const invalidProgram = join(root, "invalid.dsl");
    await writeFile(invalidProgram, "from missing()");
    const fileFailure = await run(["query", "--file", invalidProgram]);
    assert.equal(fileFailure.code, 2);
    assert.equal(JSON.parse(fileFailure.stderr).value.locations[0].uri, invalidProgram);
    const inlineFailure = await run(["query", "--expr", "from missing()"]);
    assert.equal(inlineFailure.code, 2);
    assert.equal(JSON.parse(inlineFailure.stderr).value.locations[0].uri, "argv:program");
    const stdinFailure = await run(["query", "-"], { input: "from missing()" });
    assert.equal(stdinFailure.code, 2);
    assert.equal(JSON.parse(stdinFailure.stderr).value.locations[0].uri, "stdin:program");

    const markdown = join(root, "warning.md");
    await writeFile(markdown, "# One\n### Skipped\n");
    const piped = await run(
      ["query", "--stdin"],
      { input: `from markdown({ uri: ${JSON.stringify(markdown)} }) | select 'markdown::heading'` },
    );
    assert.equal(piped.code, 0);
    assert.match(piped.stdout, /"type":"data"/);
    assert.match(piped.stderr, /"type":"diagnostic"/);

    const ambiguous = await run(["query", "--file", program, "--expr", source]);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.stderr, /exactly one input mode/i);
  }));

test("query streams stable redacted JSON Lines with diagnostics on stderr", async () =>
  fixture(async (root) => {
    const data = join(root, "data.json");
    const program = join(root, "query.dsl");
    await writeFile(data, '{"name":"demo","password":"DO-NOT-LEAK"}\n');
    await writeFile(program, [
      `from json({ uri: ${JSON.stringify(data)} })`,
      "| select 'json::property[name = \"password\"] > json::scalar'",
      "| project { password: @value }",
    ].join("\n"));
    const result = await run(["query", program]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes("DO-NOT-LEAK"), false);
    const lines = result.stdout.trim().split("\n").map(JSON.parse);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].type, "data");

    const markdown = join(root, "warning.md");
    const warningProgram = join(root, "warning.dsl");
    await writeFile(markdown, "# One\n### Skipped\n");
    await writeFile(warningProgram, `from markdown({ uri: ${JSON.stringify(markdown)} }) | select 'markdown::heading'`);
    const warned = await run(["query", warningProgram]);
    assert.equal(warned.code, 0);
    assert.match(warned.stdout, /"type":"data"/);
    assert.match(warned.stderr, /"type":"diagnostic"/);
    assert.equal(warned.stderr.includes("# One"), false);
  }));

test("filesystem selectors emit nested files once after the source walk", async () =>
  fixture(async (root) => {
    const nested = join(root, "nested");
    const program = join(root, "files.dsl");
    await mkdir(nested);
    await writeFile(join(root, "root.ts"), "export {};\n");
    await writeFile(join(nested, "nested.ts"), "export {};\n");
    await writeFile(program, [
      `from fs({ uri: ${JSON.stringify(root)} })`,
      "| select 'fs::file[extension = \".ts\"]'",
      "| project { path: @path }",
      "| sort path",
    ].join("\n"));

    const result = await run(["query", program]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(
      result.stdout.trim().split("\n").map(JSON.parse).map(({ value }) => value.path),
      ["nested/nested.ts", "root.ts"],
    );
  }));

test("selectors cross filesystem mount boundaries without losing adapter schemas", async () =>
  fixture(async (root) => {
    const fixtures = [
      { extension: "json", content: '{"value":1}\n', mount: "json", kind: "json::root" },
      { extension: "md", content: "# Title\n", mount: "markdown", kind: "markdown::document" },
      { extension: "ts", content: "call();\n", mount: "ts", kind: "ts::source-file" },
    ];
    await Promise.all(fixtures.map(async ({ extension, content }) => {
      await writeFile(join(root, `input.${extension}`), content);
    }));
    for (const { extension, mount, kind } of fixtures) {
      const program = [
        `from fs({ uri: ${JSON.stringify(root)}, include: ["**/*.${extension}"], kinds: ["fs::file"] })`,
        `| mount ${mount}()`,
        `| select 'fs::file > ${kind}'`,
        "| count",
      ].join("\n");
      // oxlint-disable-next-line no-await-in-loop -- each mount owns sequential fixture I/O.
      const result = await run(["query", "--expr", program]);
      assert.equal(result.code, 0, `${mount}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).value, 1);
    }
  }));

test("filesystem CLI operations preview and apply the complete encoded surface", async () =>
  fixture(async (root) => {
    await Promise.all([
      writeFile(join(root, "write.bin"), "before"),
      writeFile(join(root, "move.txt"), "move"),
      writeFile(join(root, "remove.txt"), "remove"),
      mkdir(join(root, "create-here")),
    ]);
    const source = (path, kind = "fs::file") =>
      `from fs({ uri: ${JSON.stringify(root)}, include: [${JSON.stringify(path)}], kinds: ["${kind}"] })`;
    const programs = [
      {
        name: "write",
        program: `${source("write.bin")} | invoke fs::write { encoding: "base64", content: "AAEC/w==" } | plan`,
        acknowledgement: ["--allow-destructive"],
        verify: async () => assert.deepEqual([...await readFile(join(root, "write.bin"))], [0, 1, 2, 255]),
      },
      {
        name: "move",
        program: `${source("move.txt")} | invoke fs::move { destination: "moved.txt" } | plan`,
        acknowledgement: [],
        verify: async () => {
          assert.equal(await readFile(join(root, "moved.txt"), "utf8"), "move");
          await assert.rejects(readFile(join(root, "move.txt")), /ENOENT/);
        },
      },
      {
        name: "remove",
        program: `${source("remove.txt")} | invoke fs::remove {} | plan`,
        acknowledgement: ["--allow-destructive"],
        verify: async () => assert.rejects(readFile(join(root, "remove.txt")), /ENOENT/),
      },
      {
        name: "create-file",
        program: `${source("create-here", "fs::directory")} | invoke fs::create { name: "created.txt", nodeKind: "file", encoding: "utf8", content: "created" } | plan`,
        acknowledgement: [],
        verify: async () => assert.equal(await readFile(join(root, "create-here", "created.txt"), "utf8"), "created"),
      },
      {
        name: "create-directory",
        program: `${source("create-here", "fs::directory")} | invoke fs::create { name: "nested", nodeKind: "directory" } | plan`,
        acknowledgement: [],
        verify: async () => assert.equal((await stat(join(root, "create-here", "nested"))).isDirectory(), true),
      },
    ];
    for (const operation of programs) {
      // oxlint-disable-next-line no-await-in-loop -- operations mutate sequential fixture revisions.
      const preview = await run(["plan", "--expr", operation.program]);
      assert.equal(preview.code, 0, `${operation.name}: ${preview.stderr}`);
      // oxlint-disable-next-line no-await-in-loop -- each apply depends on its preview remaining effect-free.
      const applied = await run(["apply", "--expr", operation.program, "--yes", ...operation.acknowledgement]);
      assert.equal(applied.code, 0, `${operation.name}: ${applied.stderr}`);
      // oxlint-disable-next-line no-await-in-loop -- verify after the corresponding apply.
      await operation.verify();
    }

    const invalid = [
      `${source("write.bin")} | invoke fs::write { content: "x" } | plan`,
      `${source("write.bin")} | invoke fs::write { encoding: "hex", content: "00" } | plan`,
      `${source("moved.txt")} | invoke fs::move {} | plan`,
      `${source("create-here", "fs::directory")} | invoke fs::create { name: "bad", nodeKind: "link" } | plan`,
    ];
    await Promise.all(invalid.map(async (program) => {
      const result = await run(["plan", "--expr", program]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /dsl\.(?:missing-argument|argument-choice)/);
      assert.equal(JSON.parse(result.stderr).value.locations[0].uri, "argv:program");
    }));

    const duplicatePlan = join(root, "duplicate-plan.json");
    const duplicate = [
      `from fs({ uri: ${JSON.stringify(root)}, include: ["write.bin", "*.bin"], kinds: ["fs::file"] })`,
      '| invoke fs::write { encoding: "utf8", content: "once" }',
      "| plan",
    ].join("\n");
    const planned = await run(["plan", "--expr", duplicate, "--save", duplicatePlan]);
    assert.equal(planned.code, 0);
    assert.equal(JSON.parse(await readFile(duplicatePlan, "utf8")).plan.changes.length, 1);
  }));

test("plan previews cannot apply and saved destructive plans require acknowledgements", async () =>
  fixture(async (root) => {
    const source = join(root, "code.ts");
    const program = join(root, "replace.dsl");
    const saved = join(root, "plan.json");
    await writeFile(source, "oldCall(1);\n");
    await writeFile(program, [
      `from ts({ uri: ${JSON.stringify(source)} })`,
      "| select 'ts::call[callee = \"oldCall\"]'",
      "| invoke ts::replace-call { callee: \"newCall\" }",
      "| plan",
    ].join("\n"));

    const preview = await run(["plan", program, "--save", saved]);
    assert.equal(preview.code, 0);
    assert.match(preview.stdout, /DESTRUCTIVE/);
    assert.match(preview.stdout, /content redacted/);
    assert.equal(await readFile(source, "utf8"), "oldCall(1);\n");
    const explanation = await run(["explain", program]);
    assert.match(explanation.stdout, /transactionGroups/);

    const invalid = join(root, "invalid-plan.json");
    const invalidEnvelope = JSON.parse(await readFile(saved, "utf8"));
    invalidEnvelope.integrity = "0".repeat(64);
    await writeFile(invalid, JSON.stringify(invalidEnvelope));
    const rejected = await run(["apply", invalid, "--yes", "--allow-destructive"]);
    assert.equal(rejected.code, 3);
    assert.match(rejected.stderr, /cli.invalid-plan/);
    assert.equal(await readFile(source, "utf8"), "oldCall(1);\n");

    const malformed = [
      (envelope) => { delete envelope.integrity; },
      (envelope) => { envelope.integrity = 1; },
      (envelope) => { delete envelope.plan; },
      (envelope) => { envelope.plan = null; },
      (envelope) => { delete envelope.plan.formatVersion; resignPlanEnvelope(envelope); },
      (envelope) => { envelope.plan.formatVersion = "2"; resignPlanEnvelope(envelope); },
      ...["adapters", "resources", "changes", "diagnostics", "transactionGroups"].flatMap((field) => [
        (envelope) => { delete envelope.plan[field]; resignPlanEnvelope(envelope); },
        (envelope) => { envelope.plan[field] = {}; resignPlanEnvelope(envelope); },
      ]),
    ];
    await Promise.all(malformed.map(async (mutate, index) => {
      const envelope = structuredClone(invalidEnvelope);
      mutate(envelope);
      const path = join(root, `malformed-plan-${index}.json`);
      await writeFile(path, JSON.stringify(envelope));
      const result = await run(["apply", "--file", path, "--yes", "--allow-destructive"]);
      assert.equal(result.code, 3, `mutation ${index}`);
      assert.equal(JSON.parse(result.stderr).value.code, "cli.invalid-plan", `mutation ${index}`);
    }));
    assert.equal(await readFile(source, "utf8"), "oldCall(1);\n");

    const rawPlan = join(root, "raw-plan.json");
    await writeFile(rawPlan, JSON.stringify(invalidEnvelope.plan));
    const rawRejected = await run(["apply", "--file", rawPlan, "--yes", "--allow-destructive"]);
    assert.equal(rawRejected.code, 3);
    assert.match(rawRejected.stderr, /cli.invalid-plan/);
    const inlineJson = await run(["apply", "--expr", '{"hello":"world"}', "--yes"]);
    assert.equal(inlineJson.code, 2);
    assert.match(inlineJson.stderr, /dsl\./);

    const refused = await run(["apply", saved]);
    assert.equal(refused.code, 4);
    assert.equal(await readFile(source, "utf8"), "oldCall(1);\n");
    const riskRefused = await run(["apply", saved, "--yes"]);
    assert.equal(riskRefused.code, 4);
    const applied = await run(["apply", saved, "--yes", "--allow-destructive"]);
    assert.equal(applied.code, 0);
    assert.equal(await readFile(source, "utf8"), "newCall(1);\n");
  }));

test("explain, schema, and plugins are machine-readable", async () =>
  fixture(async (root) => {
    const data = join(root, "data.json");
    const program = join(root, "explain.dsl");
    await writeFile(data, '[{"name":"b"},{"name":"a"}]\n');
    await writeFile(program, [
      `from json({ uri: ${JSON.stringify(data)} })`,
      "| select 'json::property[name = \"name\"] > json::scalar'",
      "| project { name: @value }",
      "| sort name",
    ].join("\n"));
    const explained = await run(["explain", program]);
    assert.equal(explained.code, 0);
    assert.equal(JSON.parse(explained.stdout).physical.buffering, true);
    const mountedProgram = join(root, "mounted.dsl");
    await writeFile(mountedProgram, `from fs({ uri: ${JSON.stringify(root)} }) | mount json() | select 'json::root'`);
    const mounted = await run(["explain", mountedProgram]);
    assert.match(mounted.stdout, /mount json/);

    const optionsProgram = join(root, "options.dsl");
    await writeFile(optionsProgram, [
      `from fs({ uri: ${JSON.stringify(root)}, include: ["**/*.json"], kinds: ["fs::file"] })`,
      '| mount json({ onError: "throw" })',
      "| select 'json::root'",
    ].join("\n"));
    const options = await run(["explain", optionsProgram]);
    assert.equal(options.code, 0);
    assert.match(options.stdout, /glob, kind/);
    assert.match(options.stdout, /onError=throw/);

    const invalidOptions = await run(["query", "--expr", 'from json({ extra: true })']);
    assert.equal(invalidOptions.code, 2);
    assert.match(invalidOptions.stderr, /dsl\.(?:missing|unknown)-argument/);
    const schema = await run(["schema", "json"]);
    assert.equal(JSON.parse(schema.stdout).namespace, "json");
    const plugins = await run(["plugins"]);
    assert.deepEqual(JSON.parse(plugins.stdout).builtIns.map(({ namespace }) => namespace), ["fs", "json", "markdown", "ts"]);
  }));

test("configuration precedence and usage exit codes are deterministic", async () =>
  fixture(async (root) => {
    await writeFile(join(root, ".astrc.json"), JSON.stringify({ format: "pretty", color: "never" }));
    const data = join(root, "data.json");
    const program = join(root, "query.dsl");
    await writeFile(data, '{"value":1}\n');
    await writeFile(program, `from json({ uri: ${JSON.stringify(data)} }) | select 'json::scalar'`);
    const envPretty = await run(["query", program], { cwd: root, env: { AST_FORMAT: "jsonl" } });
    assert.match(envPretty.stdout, /"type":"data"/);
    const flagPretty = await run(["query", program, "--format", "pretty"], { cwd: root, env: { AST_FORMAT: "jsonl" } });
    assert.equal(flagPretty.stdout.includes('"type":"data"'), false);
    const usage = await run(["unknown"]);
    assert.equal(usage.code, 1);
  }));

test("global and command help plus version are successful public surfaces", async () => {
  const cases = [
    { args: ["--help"], expected: /Commands:/ },
    { args: ["help"], expected: /Commands:/ },
    { args: ["help", "query"], expected: /Usage: ast query/ },
    ...["query", "plan", "apply", "explain", "schema", "plugins"].map((command) => ({
      args: [command, "--help"],
      expected: new RegExp(`Usage: ast ${command}`),
    })),
  ];
  const results = await Promise.all(cases.map(async ({ args, expected }) => {
    const result = await run(args);
    assert.equal(result.code, 0, args.join(" "));
    assert.equal(result.stderr, "", args.join(" "));
    assert.match(result.stdout, expected, args.join(" "));
  }));
  assert.equal(results.length, cases.length);

  await Promise.all([["--version"], ["-V"]].map(async (args) => {
    const result = await run(args);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "ast 0.0.0\n");
  }));
});

test("command shapes and option values fail with stable usage diagnostics", async () => {
  const cases = [
    [],
    ["unknown"],
    ["query"],
    ["query", "--expr"],
    ["query", "--expr", "from fs()", "--save", "plan.json"],
    ["query", "--expr", "from fs()", "--diff-provider", "diff"],
    ["query", "--expr", "from fs()", "--renderer"],
    ["query", "--expr", "from fs()", "--yes"],
    ["plan", "--expr", "from fs()", "--allow-destructive"],
    ["plan", "--expr", "from fs()", "--renderer", "text"],
    ["plan", "--expr", "from fs()", "--diff-provider"],
    ["apply", "--expr", "from fs()", "--save", "plan.json"],
    ["explain", "--expr", "from fs()", "--yes"],
    ["schema"],
    ["schema", "json", "ts"],
    ["schema", "json", "--stdin"],
    ["plugins", "json"],
    ["plugins", "--file", "query.dsl"],
    ["plugins", "--format"],
    ["plugins", "--format", "yaml"],
    ["plugins", "--color"],
    ["plugins", "--color", "rainbow"],
    ["plugins", "--config"],
    ["plan", "--expr", "from fs()", "--save"],
    ["query", "-x"],
    ["query", "--unknown"],
    ["apply", "--expr", "from fs()", "--yes", "--yes"],
  ];
  await Promise.all(cases.map(async (args) => {
    const result = await run(args);
    assert.equal(result.code, 1, args.join(" "));
    assert.equal(JSON.parse(result.stderr).value.code, "cli.usage", args.join(" "));
  }));
});

test("configuration sources are completely validated before use", async () =>
  fixture(async (root) => {
    const invalid = [
      null,
      [],
      { extra: true },
      { format: "yaml" },
      { color: "rainbow" },
      { plugins: {} },
      { plugins: [null] },
      { plugins: [{}] },
      { plugins: [{ specifier: "./plugin.mjs", name: "demo", powers: ["unknown"] }] },
      { plugins: [{ specifier: "./plugin.mjs", name: "demo", aliases: { sources: [] } }] },
      { plugins: [{ specifier: "./plugin.mjs", name: "demo", aliases: { unknown: {} } }] },
      { plugins: [{ specifier: "./one.mjs", name: "demo" }, { specifier: "./two.mjs", name: "demo" }] },
      { plugins: [
        { specifier: "./one.mjs", name: "one", aliases: { sources: { demo: "one::source" } } },
        { specifier: "./two.mjs", name: "two", aliases: { sources: { demo: "two::source" } } },
      ] },
    ];
    const paths = await Promise.all(invalid.map(async (value, index) => {
      const path = join(root, `invalid-${index}.json`);
      await writeFile(path, JSON.stringify(value));
      return path;
    }));
    const failures = await Promise.all([
      ...paths.map((path) => run(["plugins", "--config", path], { cwd: root })),
      run(["plugins", "--config", join(root, "missing.json")], { cwd: root }),
      run(["plugins"], { cwd: root, env: { AST_FORMAT: "yaml" } }),
      run(["plugins"], { cwd: root, env: { AST_COLOR: "rainbow" } }),
    ]);
    for (const failure of failures) {
      assert.equal(failure.code, 1);
      assert.equal(JSON.parse(failure.stderr).value.code, "cli.invalid-config");
    }

    await writeFile(join(root, ".astrc.json"), "not json");
    const malformed = await run(["plugins"], { cwd: root });
    assert.equal(malformed.code, 1);
    assert.equal(JSON.parse(malformed.stderr).value.code, "cli.invalid-config");
  }));

test("explicitly allowlisted plugins load as trusted code and enforce powers before use", async () =>
  fixture(async (root) => {
    const plugin = join(root, "plugin.mjs");
    const config = join(root, "plugins.json");
    await writeFile(plugin, [
      `import { fromAdapter } from ${JSON.stringify(pathToFileURL(core).href)};`,
      "const schema = { namespace: 'example', version: '1.0.0', dynamic: true, kinds: [{ kind: 'example::item', attributes: { index: { scalar: 'number', cardinality: 'one', required: true } }, identity: { stability: 'observation', description: 'Fixture item index.' } }], edges: [], operations: [], treeViews: [{ name: 'example::tree', rootKinds: ['example::item'], childEdges: [], default: true }], capabilities: { traversal: ['tree'], pushdown: [], ordering: 'stable', revisions: false, transactions: 'none' } };",
      "const adapter = { contractVersion: '1', namespace: 'example', schema, read: { open: async (source) => ({ resource: { id: 'fixture', adapter: 'example', uri: source.uri }, close: async () => {} }), roots: async function* (resource) { for (let index = 0; index < 3; index += 1) yield { id: { adapter: 'example', resource: resource.id, local: String(index) }, kind: 'example::item', attributes: { index } }; }, edges: async function* () {}, hydrate: async () => [] } };",
      "export default {",
      "  manifest: { apiVersion: '1', name: '@example/ast-plugin', version: '1.0.0', integrity: 'sha256:fixture-1', namespaces: ['example'], powers: ['resource:read'], contributions: { adapters: ['example'], schemas: ['example'], resolvers: ['example::source'], mounts: [], operations: [], predicates: [], functions: [], renderers: [], diffProviders: [], optimizerRules: [] } },",
      "  contributions: { adapters: [adapter], schemas: [schema], resolvers: [{ name: 'example::source', adapter, selectorSource: 'roots', arguments: {}, open: () => fromAdapter(adapter, { uri: 'example:fixture' }) }] },",
      "};",
    ].join("\n"));
    const entry = {
      specifier: plugin,
      name: "@example/ast-plugin",
      powers: ["resource:read"],
      aliases: { namespaces: { ex: "example" }, sources: { demo: "example::source" } },
    };
    await writeFile(config, JSON.stringify({ format: "jsonl", plugins: [entry] }));

    const listed = await run(["plugins", "--config", config]);
    assert.equal(listed.code, 0);
    const pluginRow = JSON.parse(listed.stdout).plugins.find(({ name }) => name === "@example/ast-plugin");
    assert.equal(pluginRow.adapters[0].namespace, "example");
    assert.equal(pluginRow.trustedCode, true);
    assert.equal(pluginRow.isolated, false);
    const queried = await run(["query", "--expr", "from demo() | count", "--config", config]);
    assert.equal(queried.code, 0);
    assert.equal(JSON.parse(queried.stdout).value, 3);
    const schema = await run(["schema", "ex", "--config", config]);
    assert.equal(JSON.parse(schema.stdout).namespace, "example");

    await writeFile(config, JSON.stringify({ plugins: [{ ...entry, powers: [] }] }));
    const unauthorized = await run(["plugins", "--config", config]);
    assert.equal(unauthorized.code, 2);
    assert.match(unauthorized.stderr, /plugin\.unauthorized-power/);
  }));

test("plugin-only presentation contributions are inventoried and safely selected", async () =>
  fixture(async (root) => {
    const { runCli, EXIT } = await import("../dist/index.js");
    const plugin = join(root, "presentation.mjs");
    const config = join(root, "plugins.json");
    const data = join(root, "data.json");
    const source = join(root, "code.ts");
    await writeFile(data, '{"password":"DO-NOT-LEAK"}\n');
    await writeFile(source, "oldCall(1);\n");
    const contributions = {
      adapters: [], schemas: [], resolvers: [], mounts: [], operations: [],
      predicates: [], functions: [],
      renderers: ["present::text", "present::broken"],
      diffProviders: ["present::diff"], optimizerRules: [],
    };
    await writeFile(plugin, [
      "export default {",
      `  manifest: ${JSON.stringify({ apiVersion: "1", name: "@example/presentation", version: "1.0.0", integrity: "sha256:presentation-1", namespaces: ["present"], powers: [], contributions })},`,
      "  contributions: {",
      "    renderers: [",
      "      { name: 'present::text', render: (value) => `PLUGIN_RENDER ${JSON.stringify(value)}` },",
      "      { name: 'present::broken', render: () => { throw new Error('renderer failed'); } },",
      "    ],",
      "    diffProviders: [{ name: 'present::diff', render: (before, after) => `PLUGIN_DIFF ${before} => ${after}` }],",
      "  },",
      "};",
    ].join("\n"));
    await writeFile(config, JSON.stringify({ plugins: [{
      specifier: plugin,
      name: "@example/presentation",
      powers: [],
      aliases: { renderers: { show: "present::text", broken: "present::broken" }, diffProviders: { safe: "present::diff" } },
    }] }));

    const listed = await run(["plugins", "--config", config]);
    assert.equal(listed.code, 0);
    const inventory = JSON.parse(listed.stdout);
    assert.equal(inventory.plugins.length, 1);
    assert.equal(inventory.plugins[0].name, "@example/presentation");
    assert.equal(inventory.plugins[0].trustedCode, true);
    assert.equal(inventory.plugins[0].isolated, false);
    assert.deepEqual(inventory.plugins[0].contributions.renderers, ["present::text", "present::broken"]);
    assert.equal(inventory.plugins[0].aliases.renderers.show, "present::text");
    assert.deepEqual(inventory.plugins[0].adapters, []);

    const invoke = async (args, stdoutIsTTY) => {
      let stdout = "";
      let stderr = "";
      const code = await runCli(args, {
        stdout: { write: (value) => { stdout += value; } },
        stderr: { write: (value) => { stderr += value; } },
        stdinIsTTY: false,
        stdoutIsTTY,
        cwd: root,
        env: { NO_COLOR: "1" },
      });
      return { code, stdout, stderr };
    };
    const query = `from json({ uri: ${JSON.stringify(data)} }) | select 'json::scalar' | project { password: @value }`;
    const rendered = await invoke(["query", "--expr", query, "--renderer", "show", "--config", config], true);
    assert.equal(rendered.code, EXIT.success);
    assert.match(rendered.stdout, /PLUGIN_RENDER/);
    assert.equal(rendered.stdout.includes("DO-NOT-LEAK"), false);

    const canonical = await invoke(["query", "--expr", query, "--renderer", "show", "--format", "jsonl", "--config", config], false);
    assert.equal(canonical.code, EXIT.success);
    assert.match(canonical.stdout, /"type":"data"/);
    assert.equal(canonical.stdout.includes("PLUGIN_RENDER"), false);

    const program = `from ts({ uri: ${JSON.stringify(source)} }) | select 'ts::call[callee = "oldCall"]' | invoke ts::replace-call { callee: "newCall" } | plan`;
    const diffed = await invoke(["plan", "--expr", program, "--diff-provider", "safe", "--config", config], true);
    assert.equal(diffed.code, EXIT.success);
    assert.match(diffed.stdout, /PLUGIN_DIFF \[REDACTED\] => \[REDACTED\]/);
    assert.equal(diffed.stdout.includes("oldCall(1)"), false);
    assert.equal(diffed.stdout.includes("newCall(1)"), false);

    const failed = await invoke(["query", "--expr", query, "--renderer", "broken", "--config", config], true);
    assert.equal(failed.code, EXIT.diagnostic);
    assert.equal(failed.stdout, "");
    assert.match(failed.stderr, /plugin\.presentation-failed/);
  }));

test("an already-aborted invocation returns the cancellation exit code", async () => {
  const { runCli, EXIT } = await import("../dist/index.js");
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    ["query", "--expr", 'from json({ uri: "missing.json" })'],
    {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      stdinIsTTY: false,
      stdoutIsTTY: false,
      cwd: process.cwd(),
      env: { NO_COLOR: "1" },
      signal: controller.signal,
    },
  );
  assert.equal(code, EXIT.cancelled);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});

test("cancellation interrupts a blocked standard-input read", async () => {
  const { runCli, EXIT } = await import("../dist/index.js");
  const controller = new AbortController();
  let startedRead;
  const reading = new Promise((resolve) => { startedRead = resolve; });
  const stdin = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        startedRead();
        return new Promise(() => {});
      },
      return: async () => ({ done: true }),
    }),
  };
  let stdout = "";
  let stderr = "";
  const result = runCli(
    ["query", "--stdin"],
    {
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
      stdin,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      cwd: process.cwd(),
      env: { NO_COLOR: "1" },
      signal: controller.signal,
    },
  );
  await reading;
  controller.abort(new Error("cancelled"));

  assert.equal(await result, EXIT.cancelled);
  assert.equal(stdout, "");
  assert.equal(stderr, "");
});
