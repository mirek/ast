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
    assert.equal(adapter.diagnostics().some(({ code }) => code === "ts.syntax-error"), true);
    const plan = await planOperations([{ id: "call", adapter, operation: typeScriptReplaceCall(call.snapshot, "newCall") }]);
    await applyChangePlan(plan, [createTypeScriptAdapter()]);
    assert.equal((await readFile(path, "utf8")).startsWith("const value = newCall(1);"), true);
  }));
