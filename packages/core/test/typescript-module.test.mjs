import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createTypeScriptAdapter, select } from "@mirek/ast";

const fixture = async (run) => {
  const root = await mkdtemp(join(tmpdir(), "ast-module-"));
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "nodenext", target: "es2022", baseUrl: ".", paths: { "@lib/*": ["./*.ts"] } }, include: ["*.ts"] }));
    return await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
};

test("syntax-only TSX and JSX modules use their file syntax", async () => fixture(async (root) => {
  const inspect = async (extension) => {
    const path = join(root, `view.${extension}`);
    await writeFile(path, 'export const View = () => <main title="Welcome" />;\n');
    const adapter = createTypeScriptAdapter();
    const handle = await adapter.read.open({ uri: path }, {});
    try {
      assert.deepEqual((await adapter.moduleInfo(handle.resource)).exports.map(item => item.name), ["View"]);
      assert.equal(adapter.diagnostics().some(item => item.severity === "error"), false);
      assert.equal((await select(adapter, { uri: path }, 'ts::node[syntaxKind = "JsxSelfClosingElement"]').toArray()).length, 1);
    } finally { await handle.close(); }
  };
  await inspect("tsx");
  await inspect("jsx");
}));

test("module inventory handles CommonJS assignment, namespaces and multi-variable JSDoc", async () => fixture(async (root) => {
  await writeFile(join(root, "values.ts"), '/** API values. */\nexport const first = 1, second = 2;\n');
  await writeFile(join(root, "namespace.ts"), 'export * as values from "./values.js";\n');
  await writeFile(join(root, "common.cts"), '/** Public class. */\nclass Foo { static answer = 42 }\nexport = Foo;\n');
  const config = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
  config.include.push("*.cts");
  await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
  const verify = async (options) => {
    const adapter = createTypeScriptAdapter(options);
    const inspect = async (file) => {
      const handle = await adapter.read.open({ uri: join(root, file) }, {});
      try { return await adapter.moduleInfo(handle.resource); }
      finally { await handle.close(); }
    };
    const common = await inspect("common.cts");
    assert.deepEqual(common.exports.map(item => item.name), ["export="]);
    const values = await inspect("values.ts");
    assert.equal(values.exports.length, 2);
    assert.equal(values.exports.every(item => item.documentation?.includes("API values")), true);
    const namespace = await inspect("namespace.ts");
    assert.equal(namespace.exports[0].name, "values");
    assert.equal(namespace.exports[0].localName, undefined);
  };
  await verify({});
  await verify({ project: join(root, "tsconfig.json") });
}));

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

test("exported import-equals aliases appear outside configured projects", async () => fixture(async (root) => {
  await writeFile(join(root, "index.cts"), 'export import API = require("./api.cjs");\n');
  const adapter = createTypeScriptAdapter();
  const handle = await adapter.read.open({ uri: join(root, "index.cts") }, {});
  try {
    const info = await adapter.moduleInfo(handle.resource);
    assert.deepEqual(info.exports.map(item => item.name), ["API"]);
    assert.equal(info.exports[0].localName, "API");
    assert.equal(info.exports[0].typeOnly, false);
  } finally { await handle.close(); }
}));

test("configured import resolution stays with its captured compiler snapshot", async () => fixture(async (root) => {
  await writeFile(join(root, "lib.ts"), "export const value = 1;\n");
  await writeFile(join(root, "setup.ts"), "console.log(1);\n");
  await writeFile(join(root, "index.ts"), 'import { value } from "./lib.js"; import "./later.js"; import "./setup.js"; export { value };\n');
  const adapter = createTypeScriptAdapter({ project: join(root, "tsconfig.json") });
  const handle = await adapter.read.open({ uri: join(root, "index.ts") }, {});
  try {
    const before = await adapter.moduleInfo(handle.resource);
    assert.ok(before.imports[0].resolvedUri?.endsWith("/lib.ts"));
    assert.equal(before.imports[1].resolvedUri, undefined);
    assert.ok(before.imports[2].resolvedUri?.endsWith("/setup.ts"));
    await rm(join(root, "lib.ts"));
    await writeFile(join(root, "later.ts"), "export const later = true;\n");
    assert.deepEqual(await adapter.moduleInfo(handle.resource), before);
  } finally { await handle.close(); }
}));

test("declaration revisions never label a different compiler source snapshot", async () => fixture(async (root) => {
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "nodenext" }, files: ["index.ts"], include: [] }));
  await writeFile(join(root, "lib.ts"), "/** Old API. */\nexport const value = 1;\n");
  await writeFile(join(root, "index.ts"), 'export { value } from "./lib.js";\n');
  const adapter = createTypeScriptAdapter({ project: join(root, "tsconfig.json") });
  const entry = await adapter.read.open({ uri: join(root, "index.ts") }, {});
  try {
    await writeFile(join(root, "lib.ts"), "/** New API with a different source length. */\nexport const value = 123;\n");
    const dependency = await adapter.read.open({ uri: join(root, "lib.ts") }, {});
    try {
      const declaration = (await adapter.moduleInfo(entry.resource)).exports[0];
      assert.match(declaration.documentation, /Old API/);
      assert.equal(declaration.origin.revision, undefined);
      assert.notEqual(declaration.origin.revision, dependency.resource.revision);
    } finally { await dependency.close(); }
  } finally { await entry.close(); }
}));

test("exported type-only import-equals aliases keep their type status in both modes", async () => fixture(async (root) => {
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "nodenext" }, include: ["*.cts"] }));
  await writeFile(join(root, "api.cts"), "class API {}\nexport = API;\n");
  await writeFile(join(root, "index.cts"), 'export import type API = require("./api.cjs");\n');
  await Promise.all([{}, { project: join(root, "tsconfig.json") }].map(async options => {
    const adapter = createTypeScriptAdapter(options);
    const handle = await adapter.read.open({ uri: join(root, "index.cts") }, {});
    try {
      const info = await adapter.moduleInfo(handle.resource);
      assert.deepEqual(info.exports.map(item => item.name), ["API"]);
      assert.equal(info.exports[0].typeOnly, true);
    } finally { await handle.close(); }
  }));
}));

test("erased namespaces and destructured JSDoc agree in both analysis modes", async () => fixture(async (root) => {
  await writeFile(join(root, "index.ts"), [
    'export namespace Types { export interface X {} }',
    'export namespace Empty {}',
    'export namespace Nested { export namespace Types { export type T = string } }',
    'export namespace Values { export const value = 1 }',
    'export { Types as Alias };',
    'const source = { value: 1, nested: { leaf: 2 } };',
    '/** Public destructuring. */ export const { value, nested: { leaf } } = source;',
    '/** Public tuple. */ export const [first, ...rest] = [1, 2, 3];',
  ].join('\n'));
  await Promise.all([{}, { project: join(root, "tsconfig.json") }].map(async options => {
    const adapter = createTypeScriptAdapter(options);
    const handle = await adapter.read.open({ uri: join(root, "index.ts") }, {});
    try {
      const info = await adapter.moduleInfo(handle.resource);
      const byName = new Map(info.exports.map(item => [item.name, item]));
      for (const name of ["Types", "Empty", "Nested", "Alias"]) assert.equal(byName.get(name).typeOnly, true, `${info.mode}: ${name}`);
      assert.equal(byName.get("Values").typeOnly, false);
      for (const name of ["value", "leaf"]) assert.match(byName.get(name).documentation, /Public destructuring/, `${info.mode}: ${name}`);
      for (const name of ["first", "rest"]) assert.match(byName.get(name).documentation, /Public tuple/, `${info.mode}: ${name}`);
      assert.deepEqual(await adapter.moduleInfo(handle.resource), info);
    } finally { await handle.close(); }
  }));
}));


test("syntax namespace binding performs no fresh filesystem canonicalization", async () => fixture(async (root) => {
  await writeFile(join(root, "index.ts"), "export namespace Types { export interface Item {} }\n");
  const adapter = createTypeScriptAdapter();
  const handle = await adapter.read.open({ uri: join(root, "index.ts") }, {});
  const original = realpathSync.native;
  let reads = 0;
  realpathSync.native = (...args) => { reads++; return original(...args); };
  try {
    assert.equal((await adapter.moduleInfo(handle.resource)).exports[0].typeOnly, true);
    assert.equal(reads, 0);
  } finally { realpathSync.native = original; await handle.close(); }
}));

test("type-only re-export chains preserve erasure and explicit value routes", async () => fixture(async (root) => {
  await writeFile(join(root, "origin.ts"), "export class Foo {}\n");
  await writeFile(join(root, "named.ts"), 'export type { Foo } from "./origin.js";\n');
  await writeFile(join(root, "star.ts"), 'export type * from "./origin.js";\n');
  await writeFile(join(root, "named-chain.ts"), 'export * from "./named.js";\n');
  await writeFile(join(root, "star-chain.ts"), 'export * from "./star.js";\n');
  await writeFile(join(root, "local.ts"), 'import { Foo } from "./star.js"; export { Foo };\n');
  await writeFile(join(root, "mixed.ts"), 'export * from "./named.js"; export { Foo } from "./origin.js";\n');
  await writeFile(join(root, "mixed-star.ts"), 'export * from "./named.js"; export * from "./origin.js";\n');
  await writeFile(join(root, "cycle-a.ts"), 'export * from "./cycle-b.js";\n');
  await writeFile(join(root, "cycle-b.ts"), 'export * from "./cycle-a.js"; export type { Foo } from "./origin.js";\n');
  const inspect = async (file, expected) => {
    const adapter = createTypeScriptAdapter({ project: join(root, "tsconfig.json") });
    const handle = await adapter.read.open({ uri: join(root, file) }, {});
    try { assert.equal((await adapter.moduleInfo(handle.resource)).exports.find(item => item.name === "Foo").typeOnly, expected, file); }
    finally { await handle.close(); }
  };
  await Promise.all(["named-chain.ts", "star-chain.ts", "local.ts", "cycle-a.ts"].map(file => inspect(file, true)));
  await inspect("mixed.ts", false);
  await inspect("mixed-star.ts", false);
}));

test("merged declaration names retain aggregate value status and first-declaration metadata", async () => fixture(async (root) => {
  await writeFile(join(root, "class-first.ts"), 'export class Foo {}\nexport interface Foo { value?: number }\nexport { Foo as Alias };\n');
  await writeFile(join(root, "interface-first.ts"), 'export interface Foo { value?: number }\nexport class Foo {}\nexport { Foo as Alias };\n');
  await writeFile(join(root, "types-only.ts"), 'export interface Foo { value?: number }\nexport interface Foo { other?: string }\nexport { Foo as Alias };\n');
  await Promise.all([{}, { project: join(root, "tsconfig.json") }].map(async options => {
    const adapter = createTypeScriptAdapter(options);
    const inspect = async (file, typeOnly, kind) => {
      const handle = await adapter.read.open({ uri: join(root, file) }, {});
      try {
        const info = await adapter.moduleInfo(handle.resource);
        assert.deepEqual(info.exports.map(item => item.name), ["Foo", "Alias"]);
        for (const item of info.exports) {
          assert.equal(item.typeOnly, typeOnly, `${info.mode}: ${file}: ${item.name}`);
          assert.equal(item.declarationKind, kind, `${info.mode}: ${file}: ${item.name}`);
        }
      } finally { await handle.close(); }
    };
    await inspect("class-first.ts", false, "ClassDeclaration");
    await inspect("interface-first.ts", false, "InterfaceDeclaration");
    await inspect("types-only.ts", true, "InterfaceDeclaration");
  }));
}));

test("default identifier exports retain their local declaration and JSDoc", async () => fixture(async (root) => {
  await writeFile(join(root, "value.ts"), '/** Default API. */ const api = 1;\nexport default api;\n');
  await writeFile(join(root, "type.ts"), '/** Default shape. */ interface Shape {}\nexport default Shape;\n');
  await Promise.all([{}, { project: join(root, "tsconfig.json") }].map(async options => {
    const adapter = createTypeScriptAdapter(options);
    const inspect = async (file, localName, typeOnly, doc) => {
      const handle = await adapter.read.open({ uri: join(root, file) }, {});
      try {
        const item = (await adapter.moduleInfo(handle.resource)).exports[0];
        assert.equal(item.name, "default");
        assert.equal(item.localName, localName);
        assert.equal(item.typeOnly, typeOnly);
        assert.match(item.documentation, doc);
      } finally { await handle.close(); }
    };
    await inspect("value.ts", "api", false, /Default API/);
    await inspect("type.ts", "Shape", true, /Default shape/);
  }));
}));

test("export-equals keeps explicitly imported type-only aliases erased", async () => fixture(async (root) => {
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "nodenext" }, include: ["*.cts"] }));
  await writeFile(join(root, "api.cts"), "class API {}\nexport = API;\n");
  await writeFile(join(root, "index.cts"), 'import type API = require("./api.cjs");\nexport = API;\n');
  await Promise.all([{}, { project: join(root, "tsconfig.json") }].map(async options => {
    const adapter = createTypeScriptAdapter(options);
    const handle = await adapter.read.open({ uri: join(root, "index.cts") }, {});
    try {
      const item = (await adapter.moduleInfo(handle.resource)).exports[0];
      assert.equal(item.name, "export=");
      assert.equal(item.typeOnly, true);
    } finally { await handle.close(); }
  }));
}));
