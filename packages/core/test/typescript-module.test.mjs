import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTypeScriptAdapter } from "@mirek/ast";

const fixture = async (run) => {
  const root = await mkdtemp(join(tmpdir(), "ast-module-"));
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "nodenext", target: "es2022", baseUrl: ".", paths: { "@lib/*": ["./*.ts"] } }, include: ["*.ts"] }));
    return await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
};

test("default declarations and imported type-only aliases retain export identity in both modes", async () => fixture(async (root) => {
  await writeFile(join(root, "lib.ts"), 'export class Foo {}\nexport default class Bar {}\n');
  await writeFile(join(root, "a.ts"), 'import type Bar from "./lib.js";\nimport { type Foo as F } from "./lib.js";\nexport { F as Foo, Bar };\nexport default interface Service {}\n');
  await writeFile(join(root, "b.ts"), 'export default function greet() {}\n');
  for (const options of [{}, { project: join(root, "tsconfig.json") }]) {
    const adapter = createTypeScriptAdapter(options);
    for (const file of ["a.ts", "b.ts"]) {
      // eslint-disable-next-line no-await-in-loop -- Adapter declares parallelReads: false.
      const handle = await adapter.read.open({ uri: join(root, file) }, {});
      try {
        // eslint-disable-next-line no-await-in-loop -- Query each opened snapshot sequentially.
        const info = await adapter.moduleInfo(handle.resource);
        if (file === "a.ts") {
          assert.equal(info.exports.length, 3);
          assert.equal(info.exports.every(item => item.typeOnly), true);
          assert.equal(info.exports.find(item => item.name === "default").localName, "Service");
        } else assert.equal(info.exports[0].localName, "greet");
      } finally {
        // eslint-disable-next-line no-await-in-loop -- Close before opening the next resource.
        await handle.close();
      }
    }
  }
}));

test("module analysis resolves imports and exposes exported aliases with JSDoc", async () => fixture(async (root) => {
  await writeFile(join(root, "lib.ts"), '/** Greet a reader.\n * @param name Reader name.\n */\nexport function greet(name: string) { return name; }\n/** User identifier. */\nexport type User = string;\n/** Current version. */\nexport const version = 1;\n');
  await writeFile(join(root, "index.ts"), 'import type { User } from "@lib/lib";\nimport { greet as hello } from "./lib.js";\nimport "missing-package";\nexport { hello as welcome };\nexport type { User } from "./lib.js";\nexport * from "./lib.js";\n');
  const adapter = createTypeScriptAdapter({ project: join(root, "tsconfig.json") });
  const handle = await adapter.read.open({ uri: join(root, "index.ts") }, {});
  try {
    const info = await adapter.moduleInfo(handle.resource);
    assert.equal(info.mode, "configured-project");
    assert.equal(info.imports.length, 5);
    assert.equal(info.imports[0].typeOnly, true);
    assert.equal(info.imports[0].resolvedUri.endsWith("/lib.ts"), true);
    assert.equal(info.imports[1].resolvedUri.endsWith("/lib.ts"), true);
    assert.equal(info.imports[2].resolvedUri, undefined);
    assert.equal(info.imports[3].kind, "re-export");
    const welcome = info.exports.find(({ name }) => name === "welcome");
    assert.equal(welcome.declarationKind, "FunctionDeclaration");
    assert.equal(welcome.localName, "greet");
    assert.equal(welcome.origin.uri.endsWith("/lib.ts"), true);
    assert.match(welcome.documentation, /Greet a reader/);
    assert.match(welcome.documentation, /@param name/);
    assert.match(info.exports.find(({ name }) => name === "version").documentation, /Current version/);
    assert.equal(info.exports.find(({ name }) => name === "User").typeOnly, true);
    assert.equal(info.imports[0].origin.range.startLine, 0);
    assert.equal(info.imports[0].origin.revision, handle.resource.revision);
    assert.equal(Object.isFrozen(info), true);
  } finally { await handle.close(); }
}));

test("syntax-only analysis reports direct exports without inventing resolution", async () => fixture(async (root) => {
  await writeFile(join(root, "a.ts"), '/** Count. */\nexport const count = 1;\nexport default function () {}\nexport { count as total };\nexport * from "./unknown.js";\n');
  const adapter = createTypeScriptAdapter();
  const handle = await adapter.read.open({ uri: join(root, "a.ts") }, {});
  try {
    const info = await adapter.moduleInfo(handle.resource);
    assert.equal(info.mode, "syntax-only");
    assert.deepEqual(info.exports.map(({ name }) => name), ["count", "default", "total"]);
    assert.match(info.exports[0].documentation, /Count/);
    assert.equal(info.imports[0].resolvedUri, undefined);
    const signal = AbortSignal.abort(new Error("cancelled"));
    await assert.rejects(adapter.moduleInfo(handle.resource, { signal }), /cancelled/);
  } finally { await handle.close(); }
}));

test("type-only re-exports and files outside the project keep their actual semantics", async () => fixture(async (root) => {
  await writeFile(join(root, "lib.ts"), '/** Public implementation. */\nexport class Service {}\n');
  await writeFile(join(root, "index.ts"), 'export type * from "./lib.js";\nexport type { Service as Contract } from "./lib.js";\n');
  await writeFile(join(root, "outside.js"), 'export const loose = 1;\n');
  const adapter = createTypeScriptAdapter({ project: join(root, "tsconfig.json") });
  const handle = await adapter.read.open({ uri: join(root, "index.ts") }, {});
  try {
    const info = await adapter.moduleInfo(handle.resource);
    assert.equal(info.exports.length, 2);
    assert.equal(info.exports.every(item => item.typeOnly), true);
    assert.equal(info.exports.every(item => item.localName === "Service"), true);
    await assert.rejects(adapter.moduleInfo({ ...handle.resource, revision: "different" }), /snapshot/);
    const outside = await adapter.read.open({ uri: join(root, "outside.js") }, {});
    try { assert.equal((await adapter.moduleInfo(outside.resource)).mode, "syntax-only"); }
    finally { await outside.close(); }
  } finally { await handle.close(); }
}));
