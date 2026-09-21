import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyChangePlan,
  createFilesystemAdapter,
  createTypeScriptAdapter,
  fromFilesystem,
  mountTypeScript,
  planOperations,
  select,
  selectFrom,
  typeScriptRenameSymbol,
  typeScriptReplaceCall,
} from "@mirek/ast";

const fixture = async (run) => {
  const root = await mkdtemp(join(tmpdir(), "ast-ts-"));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
};

test("TypeScript project mode exposes syntax and explicit cross-file symbol edges", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "esnext", target: "es2022" }, include: ["*.ts"] }));
    await writeFile(join(root, "a.ts"), 'export function greet(name: string) { return "greet " + name; }\n');
    await writeFile(join(root, "b.ts"), 'import { greet } from "./a.js";\nconsole.log(greet("world"));\n');
    await writeFile(join(root, "types.d.ts"), "declare const generated: string;\n");
    const adapter = createTypeScriptAdapter({ project: join(root, "tsconfig.json") });
    const files = fromFilesystem(createFilesystemAdapter(), { uri: root, include: ["*.ts"], kinds: ["fs::file"] });
    const graph = await mountTypeScript(files, adapter).traverse({ roles: ["child"], maxDepth: 20 }).toArray();
    assert.equal(graph.some(({ snapshot }) => snapshot.kind === "ts::function"), true);
    assert.equal(graph.some(({ snapshot }) => snapshot.kind === "ts::call"), true);
    assert.equal(
      graph.some(
        ({ snapshot }) =>
          snapshot.kind === "ts::source-file" && snapshot.attributes.declaration === true,
      ),
      true,
    );

    const callReference = graph.find(({ snapshot }) => snapshot.kind === "ts::identifier" && snapshot.attributes.name === "greet" && snapshot.origin?.uri.endsWith("/b.ts"));
    assert(callReference);
    const symbolEdges = await Array.fromAsync(callReference.edges({ names: ["ts::symbol"], roles: ["reference"] }));
    assert.equal(symbolEdges.length, 1);
    const declaration = await callReference.resolve(symbolEdges[0].to);
    assert.equal(declaration?.snapshot.origin?.uri.endsWith("/a.ts"), true);
    assert.equal(adapter.statistics().programsCreated, 1);
    assert.equal(adapter.statistics().sourceFilesParsed, 3);
  }));

test("semantic rename updates proven references but not text matches", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "esnext" }, include: ["*.ts"] }));
    await writeFile(join(root, "a.ts"), 'export function greet() { return "greet"; }\n');
    await writeFile(join(root, "b.ts"), 'import { greet } from "./a.js"; greet();\n');
    const adapter = createTypeScriptAdapter({ project: join(root, "tsconfig.json") });
    const [identifier] = await select(adapter, { uri: join(root, "a.ts") }, 'ts::identifier[name = "greet"]').toArray();
    assert(identifier);
    const plan = await planOperations([{ id: "rename", adapter, operation: typeScriptRenameSymbol(identifier.snapshot, "welcome") }]);
    assert.equal(plan.changes.length, 2);
    assert.equal((await readFile(join(root, "a.ts"), "utf8")).includes("function greet"), true);
    const result = await applyChangePlan(plan, [createTypeScriptAdapter()]);
    assert.equal(result.groups.every(({ status }) => status === "applied"), true);
    assert.equal(await readFile(join(root, "a.ts"), "utf8"), 'export function welcome() { return "greet"; }\n');
    assert.equal(await readFile(join(root, "b.ts"), "utf8"), 'import { welcome } from "./a.js"; welcome();\n');
  }));

test("syntax-only mode remains queryable with diagnostics and call replacement", async () =>
  fixture(async (root) => {
    const path = join(root, "loose.js");
    await writeFile(path, "const value = oldCall(1);\nfunction broken( {\n");
    const adapter = createTypeScriptAdapter();
    const [call] = await select(adapter, { uri: path }, 'ts::call[callee = "oldCall"]').toArray();
    assert(call);
    assert.equal((await Array.fromAsync(call.edges({ roles: ["reference"] }))).length, 0);
    assert.equal(adapter.diagnostics().some(({ code }) => code === "ts.syntax-only"), true);
    assert.equal(adapter.diagnostics().some(({ code }) => code === "ts.syntax-error"), true);
    const plan = await planOperations([{ id: "call", adapter, operation: typeScriptReplaceCall(call.snapshot, "newCall") }]);
    await applyChangePlan(plan, [createTypeScriptAdapter()]);
    assert.equal((await readFile(path, "utf8")).startsWith("const value = newCall(1);"), true);
  }));

test("reopening TypeScript files refreshes revisions without retargeting earlier handles", async () =>
  fixture(async (root) => {
    const uri = join(root, "file.ts");
    const adapter = createTypeScriptAdapter();
    await writeFile(uri, "function before() { before(); }\n");
    const [before] = await select(adapter, { uri }, "ts::function").toArray();
    const earlierEdges = await Array.fromAsync(before.edges({ names: ["ts::children"] }));
    await writeFile(uri, "function after() { after(); }\n");
    const [after] = await select(adapter, { uri }, "ts::function").toArray();
    assert.equal(after.snapshot.attributes.name, "after");
    assert.notEqual(after.snapshot.id.resource, before.snapshot.id.resource);
    assert.notEqual(after.snapshot.origin.revision, before.snapshot.origin.revision);
    assert.deepEqual(await Array.fromAsync(before.edges({ names: ["ts::children"] })), earlierEdges);
    const oldName = await before.resolve(earlierEdges[0].to);
    assert.equal(oldName.snapshot.attributes.name, "before");
    const oldCall = await select(adapter, { uri }, "ts::call").toArray();
    await writeFile(uri, "function latest() {}\n");
    await select(adapter, { uri }, "ts::function").toArray();
    await assert.rejects(adapter.planning.plan(typeScriptReplaceCall(oldCall[0].snapshot, "changed"), {}), /changed/u);
  }));

test("configured projects refresh dependencies and membership while preserving earlier symbol graphs", async () =>
  fixture(async (root) => {
    const project = join(root, "tsconfig.json");
    const declaration = join(root, "a.ts");
    const usage = join(root, "b.ts");
    await writeFile(project, JSON.stringify({ compilerOptions: { module: "esnext" }, include: ["*.ts"] }));
    await writeFile(declaration, "export function greet() {}\n");
    await writeFile(usage, 'import { greet } from "./a.js"; greet();\n');
    const adapter = createTypeScriptAdapter({ project });
    const [before] = await select(adapter, { uri: usage }, 'ts::identifier[name = "greet"]').toArray();
    const [beforeEdge] = await Array.fromAsync(before.edges({ names: ["ts::symbol"] }));
    const beforeDeclaration = await before.resolve(beforeEdge.to);
    await writeFile(declaration, "\n\nexport function greet() { return 1; }\n");
    await writeFile(join(root, "c.ts"), 'import { greet } from "./a.js"; greet();\n');
    const [after] = await select(adapter, { uri: usage }, 'ts::identifier[name = "greet"]').toArray();
    const [afterEdge] = await Array.fromAsync(after.edges({ names: ["ts::symbol"] }));
    const afterDeclaration = await after.resolve(afterEdge.to);
    assert.notDeepEqual(afterDeclaration.snapshot.id, beforeDeclaration.snapshot.id);
    assert.equal(afterDeclaration.snapshot.origin.range.start, beforeDeclaration.snapshot.origin.range.start + 2);
    assert.deepEqual(await Array.fromAsync(before.edges({ names: ["ts::symbol"] })), [beforeEdge]);
    assert.deepEqual((await before.resolve(beforeEdge.to)).snapshot, beforeDeclaration.snapshot);
    await assert.rejects(adapter.planning.plan(typeScriptRenameSymbol(beforeDeclaration.snapshot, "old"), {}), /changed/u);
    const changes = await adapter.planning.plan(typeScriptRenameSymbol(afterDeclaration.snapshot, "welcome"), {});
    assert.equal(changes.length, 3);
    await writeFile(project, JSON.stringify({ compilerOptions: { module: "esnext" }, files: ["a.ts", "b.ts"] }));
    const [reconfigured] = await select(adapter, { uri: declaration }, 'ts::identifier[name = "greet"]').toArray();
    const revisedChanges = await adapter.planning.plan(typeScriptRenameSymbol(reconfigured.snapshot, "welcome"), {});
    assert.equal(revisedChanges.length, 2);
    assert.equal(adapter.statistics().programsCreated, 3);
  }));

test("simultaneous TypeScript mounts keep separate container ownership", async () =>
  fixture(async (root) => {
    const uri = join(root, "file.ts");
    await writeFile(uri, "function hello() {}\n");
    const adapter = createTypeScriptAdapter();
    const containers = ["first", "second"].map((local) => ({ id: { adapter: "fs", resource: "fixture", local }, kind: "fs::file", attributes: {} }));
    const handles = await Promise.all(containers.map((node) => adapter.mount.open(node, { uri }, {})));
    try {
      await Promise.all(handles.map(async (handle, index) => {
        const [node] = await Array.fromAsync(adapter.read.roots(handle.resource, {}));
        const [edge] = await Array.fromAsync(adapter.read.edges(node.id, { names: ["ts::container"] }));
        assert.deepEqual(edge.to, containers[index].id);
      }));
      const direct = await adapter.read.open({ uri }, {});
      try {
        const [node] = await Array.fromAsync(adapter.read.roots(direct.resource, {}));
        assert.deepEqual(await Array.fromAsync(adapter.read.edges(node.id, { names: ["ts::container"] })), []);
      } finally { await direct.close(); }
    } finally { await Promise.all(handles.map((handle) => handle.close())); }
    await assert.rejects(adapter.read.open({ uri: join(root, "missing.ts") }, {}), { code: "ENOENT" });
    assert.equal(adapter.statistics().opened, adapter.statistics().closed);
  }));

test("cross-file symbol declarations do not inherit the referencing file's mount parent", async () =>
  fixture(async (root) => {
    const project = join(root, "tsconfig.json");
    await writeFile(project, JSON.stringify({ compilerOptions: { module: "esnext" }, include: ["*.ts"] }));
    await writeFile(join(root, "a.ts"), "export function greet() {}\n");
    await writeFile(join(root, "b.ts"), 'import { greet } from "./a.js"; greet();\n');
    const adapter = createTypeScriptAdapter({ project });
    const fs = createFilesystemAdapter();
    const mounted = mountTypeScript(fromFilesystem(fs, { uri: join(root, "b.ts") }), adapter);
    const roots = await selectFrom(mounted, [fs.schema, adapter.schema], 'fs::file > ts::source-file ts::identifier[name = "greet"] ->ts::symbol ts::identifier << ts::source-file').toArray();
    assert(roots.length > 0);
    await Promise.all(roots.map(async (node) => {
      assert(node.snapshot.origin.uri.endsWith("/a.ts"));
      assert.deepEqual(await Array.fromAsync(node.edges({ names: ["ts::mount"], direction: "reverse" })), []);
    }));
  }));

test("lazy TypeScript mounts reject changes since the containing file was observed", async () =>
  fixture(async (root) => {
    const uri = join(root, "file.ts");
    await writeFile(uri, "function before() {}\n");
    const [file] = await fromFilesystem(createFilesystemAdapter(), { uri }).toArray();
    await writeFile(uri, "function after() {}\n");
    const adapter = createTypeScriptAdapter();
    await assert.rejects(adapter.mount.open(file.snapshot, { uri }, {}), /changed/u);
    assert.equal(adapter.statistics().opened, adapter.statistics().closed);
    const [fresh] = await select(adapter, { uri }, "ts::function").toArray();
    assert.equal(fresh.snapshot.attributes.name, "after");
  }));
