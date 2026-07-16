import assert from "node:assert/strict";
import test from "node:test";

import {
  adapterCompatibility,
  createFilesystemAdapter,
  createInMemoryAdapter,
  createJsonAdapter,
  createMarkdownAdapter,
  createTypeScriptAdapter,
  validateAdapter,
} from "@mirek/ast";

test("required adapters conform to contract version 1 with honest focused capabilities", () => {
  const memory = createInMemoryAdapter({
    resource: { id: "fixture", adapter: "memory", uri: "memory:fixture" },
    roots: [], nodes: [], edges: [],
  });
  const adapters = [
    memory,
    createFilesystemAdapter(),
    createJsonAdapter(),
    createMarkdownAdapter(),
    createTypeScriptAdapter(),
  ];
  for (const adapter of adapters) {
    assert.doesNotThrow(() => validateAdapter(adapter));
    assert.deepEqual(adapterCompatibility(adapter), {
      contractVersion: "1",
      namespace: adapter.namespace,
      schemaVersion: adapter.schema.version,
    });
  }
  assert.equal(adapters[0].mount, undefined);
  assert.equal(adapters[1].mount, undefined);
  assert.equal(adapters[2].mount?.edge, "json::mount");
  assert.equal(adapters[3].mount?.edge, "markdown::mount");
  assert.equal(adapters[4].mount?.edge, "ts::mount");
});
test("invalid capability declarations fail during adapter validation", () => {
  const filesystem = createFilesystemAdapter();
  assert.throws(
    () => validateAdapter({
      contractVersion: "1",
      namespace: "fs",
      schema: filesystem.schema,
    }),
    /without read capability/,
  );
  assert.throws(
    () => validateAdapter({
      ...filesystem,
      mount: { edge: "fs::missing", open: async () => undefined },
    }),
    /mount edge is absent/,
  );
});
