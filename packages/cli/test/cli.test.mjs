import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

const fixture = async (run) => {
  const root = await mkdtemp(join(tmpdir(), "ast-cli-"));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
};

const run = async (args, options = {}) => {
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

test("query streams stable redacted JSON Lines with diagnostics on stderr", async () =>
  fixture(async (root) => {
    const data = join(root, "data.json");
    const program = join(root, "query.dsl");
    await writeFile(data, '{"name":"demo","password":"DO-NOT-LEAK"}\n');
    await writeFile(program, [
      `from json(${JSON.stringify(data)})`,
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
    await writeFile(warningProgram, `from markdown(${JSON.stringify(markdown)}) | select 'markdown::heading'`);
    const warned = await run(["query", warningProgram]);
    assert.equal(warned.code, 0);
    assert.match(warned.stdout, /"type":"data"/);
    assert.match(warned.stderr, /"type":"diagnostic"/);
    assert.equal(warned.stderr.includes("# One"), false);
  }));

test("plan previews cannot apply and saved destructive plans require acknowledgements", async () =>
  fixture(async (root) => {
    const source = join(root, "code.ts");
    const program = join(root, "replace.dsl");
    const saved = join(root, "plan.json");
    await writeFile(source, "oldCall(1);\n");
    await writeFile(program, [
      `from ts(${JSON.stringify(source)})`,
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
      `from json(${JSON.stringify(data)})`,
      "| select 'json::property[name = \"name\"] > json::scalar'",
      "| project { name: @value }",
      "| sort name",
    ].join("\n"));
    const explained = await run(["explain", program]);
    assert.equal(explained.code, 0);
    assert.equal(JSON.parse(explained.stdout).physical.buffering, true);
    const mountedProgram = join(root, "mounted.dsl");
    await writeFile(mountedProgram, `from fs(${JSON.stringify(root)}) | mount json | select 'json::root'`);
    const mounted = await run(["explain", mountedProgram]);
    assert.match(mounted.stdout, /mount json/);
    const schema = await run(["schema", "json"]);
    assert.equal(JSON.parse(schema.stdout).namespace, "json");
    const plugins = await run(["plugins"]);
    assert.deepEqual(JSON.parse(plugins.stdout).map(({ namespace }) => namespace), ["fs", "json", "markdown", "ts"]);
  }));

test("configuration precedence and usage exit codes are deterministic", async () =>
  fixture(async (root) => {
    await writeFile(join(root, ".astrc.json"), JSON.stringify({ format: "pretty", color: "never" }));
    const data = join(root, "data.json");
    const program = join(root, "query.dsl");
    await writeFile(data, '{"value":1}\n');
    await writeFile(program, `from json(${JSON.stringify(data)}) | select 'json::scalar'`);
    const envPretty = await run(["query", program], { cwd: root, env: { AST_FORMAT: "jsonl" } });
    assert.match(envPretty.stdout, /"type":"data"/);
    const flagPretty = await run(["query", program, "--format", "pretty"], { cwd: root, env: { AST_FORMAT: "jsonl" } });
    assert.equal(flagPretty.stdout.includes('"type":"data"'), false);
    const usage = await run(["unknown"]);
    assert.equal(usage.code, 1);
  }));

test("an already-aborted invocation returns the cancellation exit code", async () => {
  const { runCli, EXIT } = await import("../dist/index.js");
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    ["query", 'from json("missing.json")'],
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
