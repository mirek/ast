import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFilesystemAdapter,
  createJsonAdapter,
  fromFilesystem,
  jsonInsertArrayItem,
  jsonInsertProperty,
  jsonRemoveArrayItem,
  jsonRemoveProperty,
  jsonReplaceValue,
  mountJson,
  select,
} from "@mirek/ast";

const fixture = async (run) => {
  const root = await mkdtemp(join(tmpdir(), "ast-json-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const mountedFiles = (root, json) => {
  const filesystem = createFilesystemAdapter();
  const files = fromFilesystem(filesystem, {
    uri: root,
    include: ["*.json"],
    kinds: ["fs::file"],
  });
  return mountJson(files, json, { onError: "skip" });
};

test("JSON mounts are lazy child graphs with a reference path to their file", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "broken.json"), '{"broken": ]');
    await writeFile(
      join(root, "package.json"),
      '{"name":"ast","flags":[true,null]}\n',
    );

    const json = createJsonAdapter();
    const mounted = mountedFiles(root, json);
    assert.deepEqual(json.statistics(), {
      opened: 0,
      closed: 0,
      filesRead: 0,
      bytesRead: 0,
      parses: 0,
    });

    assert.deepEqual(
      await mounted.project((node) => node.snapshot.attributes.path).toArray(),
      ["broken.json", "package.json"],
    );
    assert.equal(json.statistics().bytesRead, 0);

    const graph = await mounted
      .traverse({ roles: ["child"], maxDepth: 8, includeSelf: true })
      .toArray();
    assert.deepEqual(
      graph.map(({ snapshot }) => [
        snapshot.kind,
        snapshot.attributes.name ??
          snapshot.attributes.index ??
          snapshot.attributes.value ??
          null,
      ]),
      [
        ["fs::file", "broken.json"],
        ["fs::file", "package.json"],
        ["json::root", null],
        ["json::object", null],
        ["json::property", "name"],
        ["json::scalar", "ast"],
        ["json::property", "flags"],
        ["json::array", null],
        ["json::index", 0],
        ["json::scalar", true],
        ["json::index", 1],
        ["json::scalar", null],
      ],
    );
    assert.deepEqual(json.statistics(), {
      opened: 2,
      closed: 2,
      filesRead: 2,
      bytesRead: 47,
      parses: 2,
    });

    const documentRoot = graph.find(({ snapshot }) => snapshot.kind === "json::root");
    assert(documentRoot);
    const [containerEdge] = await Array.fromAsync(
      documentRoot.edges({ names: ["json::container"], roles: ["reference"] }),
    );
    assert(containerEdge);
    const container = await documentRoot.resolve(containerEdge.to);
    assert.equal(container?.snapshot.kind, "fs::file");
    assert.equal(container?.snapshot.attributes.path, "package.json");

    const [diagnostic] = json.diagnostics();
    assert.equal(diagnostic?.code, "json.invalid-syntax");
    assert.equal(diagnostic?.locations[0]?.kind, "source");
    assert.equal(diagnostic?.locations[0]?.origin.range.startLine, 0);

    const failFastJson = createJsonAdapter();
    await assert.rejects(
      mountJson(
        fromFilesystem(createFilesystemAdapter(), {
          uri: root,
          include: ["broken.json"],
          kinds: ["fs::file"],
        }),
        failFastJson,
        { onError: "throw" },
      )
        .traverse({ roles: ["child"], maxDepth: 2 })
        .toArray(),
      /Cannot parse/,
    );
    assert.equal(failFastJson.statistics().opened, 1);
    assert.equal(failFastJson.statistics().closed, 1);
  }));

test("the selector engine observes explicit JSON null without inventing missing values", async () =>
  fixture(async (root) => {
    const path = join(root, "values.json");
    await writeFile(path, '{"present":null,"other":false}');
    const json = createJsonAdapter();

    const values = await select(
      json,
      { uri: path },
      "json::root json::scalar[value is null]",
    ).toArray();
    assert.equal(values.length, 1);
    assert.equal(values[0]?.snapshot.attributes.value, null);
    assert.equal(json.statistics().opened, 1);
    assert.equal(json.statistics().closed, 1);
  }));

test("early mount traversal closes the nested resource", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "data.json"), '{"nested":{"value":1}}');
    const json = createJsonAdapter();
    const values = await mountedFiles(root, json)
      .traverse({ roles: ["child"], maxDepth: 8 })
      .take(2)
      .toArray();

    assert.deepEqual(values.map(({ snapshot }) => snapshot.kind), [
      "json::root",
      "json::object",
    ]);
    assert.equal(json.statistics().opened, 1);
    assert.equal(json.statistics().closed, 1);
  }));

test("JSON operations preserve source style and plan localized edits without effects", async () =>
  fixture(async (root) => {
    const original = '\uFEFF{\r\n  "name": "ast",\r\n  "items": [1, 2]\r\n}\r\n';
    const path = join(root, "data.json");
    await writeFile(path, original);

    const json = createJsonAdapter();
    const graph = await mountedFiles(root, json)
      .traverse({ roles: ["child"], maxDepth: 8 })
      .toArray();
    const object = graph.find(({ snapshot }) => snapshot.kind === "json::object");
    const nameProperty = graph.find(
      ({ snapshot }) =>
        snapshot.kind === "json::property" && snapshot.attributes.name === "name",
    );
    const name = graph.find(
      ({ snapshot }) =>
        snapshot.kind === "json::scalar" && snapshot.attributes.value === "ast",
    );
    const array = graph.find(({ snapshot }) => snapshot.kind === "json::array");
    const secondIndex = graph.find(
      ({ snapshot }) =>
        snapshot.kind === "json::index" && snapshot.attributes.index === 1,
    );
    assert(object && nameProperty && name && array && secondIndex);

    const plan = async (operation) => {
      const [change] = await json.planning.plan(operation, {});
      assert(change);
      assert.equal(change.payload.encoding, "utf8-bom");
      assert.equal(change.payload.finalNewline, true);
      assert.equal(change.payload.strategy, "localized-text-patch");
      assert.equal(change.payload.formatting.length > 0, true);
      assert.equal(change.payload.range.end >= change.payload.range.start, true);
      return change.payload.content;
    };

    assert.equal(await plan(jsonReplaceValue(name.snapshot, "ast")), original);
    assert.equal(
      await plan(jsonReplaceValue(name.snapshot, "graph")),
      original.replace('"ast"', '"graph"'),
    );
    assert.equal(
      await plan(jsonInsertProperty(object.snapshot, "enabled", true)),
      '\uFEFF{\r\n  "name": "ast",\r\n  "items": [1, 2],\r\n  "enabled": true\r\n}\r\n',
    );
    assert.equal(
      await plan(jsonRemoveProperty(nameProperty.snapshot)),
      '\uFEFF{\r\n  "items": [1, 2]\r\n}\r\n',
    );
    assert.equal(
      await plan(jsonInsertArrayItem(array.snapshot, 1, 3)),
      '\uFEFF{\r\n  "name": "ast",\r\n  "items": [1, 3, 2]\r\n}\r\n',
    );
    assert.equal(
      await plan(jsonRemoveArrayItem(secondIndex.snapshot)),
      '\uFEFF{\r\n  "name": "ast",\r\n  "items": [1]\r\n}\r\n',
    );

    assert.equal(await readFile(path, "utf8"), original);

    await writeFile(path, '{"changed":true}\n');
    assert.deepEqual(
      await json.planning.plan(jsonReplaceValue(name.snapshot, "late"), {}),
      [],
    );
    assert.equal(json.diagnostics().at(-1)?.code, "json.revision-conflict");
  }));
