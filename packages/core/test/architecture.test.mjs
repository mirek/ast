import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyChangePlan,
  compileDsl,
  createFilesystemAdapter,
  createJsonAdapter,
  createMarkdownAdapter,
  createTypeScriptAdapter,
  defineAdapterSchema,
  defineDiagnostic,
  flatMap,
  fromAdapter,
  fromFilesystem,
  fromValues,
  jsonReplaceValue,
  markdownSetHeading,
  mountJson,
  mountMarkdown,
  mountTypeScript,
  planOperations,
  renderChangePlan,
  select,
  selectFrom,
  serializeChangePlan,
  take,
} from "@mirek/ast";

const fixture = async (run) => {
  const root = await mkdtemp(join(tmpdir(), "ast-architecture-"));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
};

const files = (filesystem, root, include) => fromFilesystem(filesystem, {
  uri: root,
  include,
  kinds: ["fs::file"],
});

test("one graph query mounts multiple formats while selectors and reference edges retain their semantics", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "config.json"), '{"enabled":true,"name":"demo"}\n');
    await writeFile(join(root, "guide.md"), "# Guide\nText.\n");
    await writeFile(join(root, "code.ts"), "export function run() { return oldCall(); }\n");
    const filesystem = createFilesystemAdapter();
    const json = createJsonAdapter();
    const markdown = createMarkdownAdapter();
    const typescript = createTypeScriptAdapter();
    const repositoryFiles = files(filesystem, root, ["*.json", "*.md"]);
    const mountedFormats = flatMap(repositoryFiles, (file) => {
      const path = file.snapshot.attributes.path;
      const singleton = fromValues([file]);
      if (typeof path === "string" && path.endsWith(".json")) {
        return mountJson(singleton, json).traverse({ roles: ["child"], maxDepth: 8, includeSelf: true });
      }
      return mountMarkdown(singleton, markdown).traverse({ roles: ["child"], maxDepth: 8, includeSelf: true });
    });
    const graph = await mountedFormats.toArray();
    assert.equal(graph.some(({ snapshot }) => snapshot.kind === "json::scalar"), true);
    assert.equal(graph.some(({ snapshot }) => snapshot.kind === "markdown::heading"), true);

    const selectedFiles = await selectFrom(
      files(filesystem, root, ["*.json"]),
      filesystem.schema,
      'fs::file[name = "config.json"]',
    ).toArray();
    const selectedJson = await selectFrom(
      mountJson(files(filesystem, root, ["*.json"]), json).traverse({ roles: ["child"], maxDepth: 8 }),
      json.schema,
      'json::property[name = "enabled"] > json::scalar[value = true]',
    ).toArray();
    const selectedCode = await selectFrom(
      mountTypeScript(files(filesystem, root, ["*.ts"]), typescript).traverse({ roles: ["child"], maxDepth: 20 }),
      typescript.schema,
      'ts::call[callee = "oldCall"]',
    ).toArray();
    assert.equal(selectedFiles.length, 1);
    assert.equal(selectedJson.length > 0, true);
    assert.equal(selectedCode.length > 0, true);

    const jsonGraph = await mountJson(files(filesystem, root, ["*.json"]), json)
      .traverse({ roles: ["child"], maxDepth: 2 })
      .toArray();
    const jsonRoot = jsonGraph.find(({ snapshot }) => snapshot.kind === "json::root");
    assert(jsonRoot);
    const childEdges = await Array.fromAsync(jsonRoot.edges({ roles: ["child"] }));
    const referenceEdges = await Array.fromAsync(jsonRoot.edges({ roles: ["reference"] }));
    assert.equal(childEdges.some(({ name }) => name === "json::container"), false);
    assert.deepEqual(referenceEdges.map(({ name }) => name), ["json::container"]);
    const container = await jsonRoot.resolve(referenceEdges[0].to);
    assert.equal(container?.snapshot.kind, "fs::file");
  }));

test("repository-scale streaming exposes pushdown, latency, early termination, cancellation, and cleanup", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "000-target.ts"), "target");
    await Promise.all(Array.from({ length: 200 }, async (_, index) => {
      const directory = join(root, `dir-${String(index).padStart(4, "0")}`);
      await mkdir(directory);
      await writeFile(join(directory, "later.ts"), "later");
    }));
    let tick = 0;
    const adapter = createFilesystemAdapter({ clock: () => tick++ });
    const source = files(adapter, root, ["**/*.ts"]);
    const first = await take(source, 1).toArray();
    assert.equal(first[0]?.snapshot.attributes.path, "000-target.ts");
    const explanation = take(source, 1).explain();
    assert.equal(explanation.physical.buffering, false);
    assert.match(explanation.physical.inputs[0].details.pushdown, /glob, kind/);
    assert.deepEqual(adapter.statistics(), {
      opened: 1,
      closed: 1,
      directoriesRead: 1,
      entriesRead: 201,
      nodesObserved: 2,
      ioOperations: 5,
      ioDurationMs: 5,
    });

    let cancellationTick = 0;
    const cancellable = createFilesystemAdapter({ clock: () => cancellationTick++ });
    const controller = new AbortController();
    const cancelled = files(cancellable, root, ["**/*.ts"]).filter(() => {
      controller.abort(new Error("stop architecture scan"));
      return true;
    });
    await assert.rejects(cancelled.toArray({ signal: controller.signal }), /stop architecture scan/);
    assert.equal(cancellable.statistics().opened, cancellable.statistics().closed);
    assert.equal(cancellable.statistics().ioOperations > 0, true);
    assert.equal(cancellable.statistics().ioDurationMs > 0, true);
  }));

test("cross-format semantic plans are pure, deterministic, applicable, and reject drift", async () =>
  fixture(async (root) => {
    const jsonPath = join(root, "config.json");
    const markdownPath = join(root, "guide.md");
    await writeFile(jsonPath, '{"name":"old"}\n');
    await writeFile(markdownPath, "# Old\nBody.\n");
    const json = createJsonAdapter();
    const markdown = createMarkdownAdapter();
    const [value] = await select(json, { uri: jsonPath }, 'json::scalar[value = "old"]').filter(() => true, "policy").toArray();
    const [heading] = await select(markdown, { uri: markdownPath }, 'markdown::heading[title = "Old"]').filter(() => true, "policy").toArray();
    assert(value && heading);
    const plan = await planOperations([
      { id: "heading", adapter: markdown, operation: markdownSetHeading(heading.snapshot, "New") },
      { id: "value", adapter: json, operation: jsonReplaceValue(value.snapshot, "new") },
    ]);
    assert.equal(await readFile(jsonPath, "utf8"), '{"name":"old"}\n');
    assert.equal(await readFile(markdownPath, "utf8"), "# Old\nBody.\n");
    assert.equal(plan.changes.length, 2);
    assert.equal(renderChangePlan(plan).includes("old"), false);
    assert.equal(serializeChangePlan(plan), serializeChangePlan(plan));
    const applied = await applyChangePlan(plan, [createMarkdownAdapter(), createJsonAdapter()]);
    assert.equal(applied.groups.every(({ status }) => status === "applied"), true);
    assert.equal(await readFile(jsonPath, "utf8"), '{"name":"new"}\n');
    assert.equal(await readFile(markdownPath, "utf8"), "# New\nBody.\n");

    const nextJson = createJsonAdapter();
    const nextMarkdown = createMarkdownAdapter();
    const [nextValue] = await select(nextJson, { uri: jsonPath }, 'json::scalar[value = "new"]').toArray();
    const [nextHeading] = await select(nextMarkdown, { uri: markdownPath }, 'markdown::heading[title = "New"]').toArray();
    assert(nextValue && nextHeading);
    const driftPlan = await planOperations([
      { id: "heading", adapter: nextMarkdown, operation: markdownSetHeading(nextHeading.snapshot, "Final") },
      { id: "value", adapter: nextJson, operation: jsonReplaceValue(nextValue.snapshot, "final") },
    ]);
    await writeFile(markdownPath, "# External\nBody.\n");
    const rejected = await applyChangePlan(driftPlan, [createMarkdownAdapter(), createJsonAdapter()]);
    assert.deepEqual(rejected.groups.map(({ status }) => status), ["failed", "skipped-policy"]);
    assert.equal(await readFile(jsonPath, "utf8"), '{"name":"new"}\n');
    assert.equal(await readFile(markdownPath, "utf8"), "# External\nBody.\n");
  }));

test("TypeScript and DSL queries share one algebra and planning diagnostics retain program and source provenance", async () => {
  const diagnostics = [];
  const schema = defineAdapterSchema({
    namespace: "probe",
    version: "1.0.0",
    dynamic: true,
    kinds: [{
      kind: "probe::node",
      attributes: { name: { scalar: "string", cardinality: "one", required: true } },
      identity: { stability: "observation", description: "Conformance probe." },
    }],
    edges: [],
    operations: [{ kind: "probe::fail", arguments: {} }],
    treeViews: [{ name: "probe::tree", rootKinds: ["probe::node"], childEdges: [], default: true }],
    capabilities: { traversal: ["tree"], pushdown: [], ordering: "stable", revisions: false, transactions: "none", semanticOperations: true },
  });
  const snapshot = {
    id: { adapter: "probe", resource: "fixture", local: "node" },
    kind: "probe::node",
    attributes: { name: "demo" },
    origin: { uri: "memory:origin", range: { start: 2, end: 6 } },
  };
  const adapter = Object.freeze({
    contractVersion: "1",
    namespace: "probe",
    schema,
    read: {
      open: async () => ({ resource: { id: "fixture", adapter: "probe", uri: "memory:origin" }, close: async () => {} }),
      roots: () => ({ async *[Symbol.asyncIterator]() { yield snapshot; } }),
      edges: () => ({ async *[Symbol.asyncIterator]() {} }),
      hydrate: async () => [snapshot],
    },
    planning: {
      plan: async (operation) => {
        diagnostics.push(defineDiagnostic({
          code: "probe.failed",
          severity: "error",
          message: "Probe operation failed at its source node.",
          locations: [{ kind: "node", node: operation.target, origin: snapshot.origin }],
        }));
        return [];
      },
    },
    diagnostics: () => diagnostics,
  });
  const environment = {
    sources: { probe: { adapter, open: () => fromAdapter(adapter, { uri: "memory:origin" }) } },
    operations: { "probe::fail": { adapter, create: (target) => ({ kind: "probe::fail", resource: "fixture", target: target.snapshot.id, payload: {} }) } },
  };
  const programmatic = selectFrom(fromAdapter(adapter, { uri: "memory:origin" }), schema, 'probe::node[name = "demo"]');
  const textual = compileDsl('from probe() | select \'probe::node[name = "demo"]\'', environment, { uri: "query.ast" });
  assert.equal(textual.kind, "query");
  assert.deepEqual(textual.query.explain().logical, programmatic.explain().logical);

  const transformation = compileDsl("from probe()\n| select 'probe::node'\n| invoke probe::fail {}\n| plan", environment, { uri: "transform.ast" });
  assert.equal(transformation.kind, "plan");
  const plan = await transformation.plan();
  const locationKinds = new Set(plan.diagnostics[0].locations.map(({ kind }) => kind));
  assert.equal(locationKinds.has("program"), true);
  assert.equal(locationKinds.has("node"), true);
  assert.equal(plan.diagnostics[0].locations.some((location) => location.kind === "node" && location.origin?.uri === "memory:origin"), true);
});
