import assert from "node:assert/strict";
import test from "node:test";

import {
  defineAdapterSchema,
  defineDiagnostic,
  defineEdge,
  defineNodeSnapshot,
  defineResource,
} from "@mirek/ast";

test("node snapshots detach and freeze public graph values", () => {
  const tags = ["source", null];
  const input = {
    id: { adapter: "memory", resource: "fixture", local: "root" },
    kind: "memory::root",
    attributes: { name: "fixture", tags },
    origin: {
      uri: "memory:fixture",
      revision: "1",
      range: { start: 0, end: 7 },
    },
  };

  const snapshot = defineNodeSnapshot(input);

  assert.notStrictEqual(snapshot, input);
  assert.deepEqual(snapshot, input);
  assert(Object.isFrozen(snapshot));
  assert(Object.isFrozen(snapshot.id));
  assert(Object.isFrozen(snapshot.attributes));
  assert(Object.isFrozen(snapshot.attributes.tags));
  assert(Object.isFrozen(snapshot.origin));
  assert(Object.isFrozen(snapshot.origin?.range));
});

test("missing attributes remain distinct from explicit null", () => {
  const snapshot = defineNodeSnapshot({
    id: { adapter: "memory", resource: "fixture", local: "value" },
    kind: "memory::value",
    attributes: { value: null },
  });

  assert.equal(snapshot.attributes.value, null);
  assert.equal("missing" in snapshot.attributes, false);
});

test("runtime definitions reject ambiguous names and invalid ranges", () => {
  assert.throws(
    () =>
      defineNodeSnapshot({
        id: { adapter: "memory", resource: "fixture", local: "root" },
        kind: "other::root",
        attributes: {},
      }),
    /adapter memory/,
  );

  assert.throws(
    () =>
      defineNodeSnapshot({
        id: { adapter: "memory", resource: "fixture", local: "root" },
        kind: "root",
        attributes: {},
      }),
    /namespaced name/,
  );

  assert.throws(
    () =>
      defineNodeSnapshot({
        id: { adapter: "memory", resource: "fixture", local: "root" },
        kind: "memory::root",
        attributes: {},
        origin: { uri: "memory:fixture", range: { start: 2, end: 1 } },
      }),
    /source range/,
  );
});

test("resource, edge, schema, and diagnostic definitions are immutable", () => {
  const resource = defineResource({
    id: "fixture",
    adapter: "memory",
    uri: "memory:fixture",
    revision: "1",
  });
  const edge = defineEdge({
    name: "memory::children",
    role: "child",
    from: { adapter: "memory", resource: "fixture", local: "root" },
    to: { adapter: "memory", resource: "fixture", local: "child" },
    ordinal: 0,
  });
  const schema = defineAdapterSchema({
    namespace: "memory",
    version: "1.0.0",
    dynamic: false,
    kinds: [
      {
        kind: "memory::root",
        attributes: {
          name: { scalar: "string", cardinality: "one", required: true },
        },
        identity: { stability: "revision", description: "fixture path" },
      },
    ],
    edges: [
      {
        name: "memory::children",
        role: "child",
        from: ["memory::root"],
        to: ["memory::root"],
        ordering: "stable",
      },
    ],
    operations: [],
    treeViews: [
      {
        name: "memory::syntax",
        rootKinds: ["memory::root"],
        childEdges: ["memory::children"],
        default: true,
      },
    ],
    capabilities: {
      traversal: ["tree"],
      pushdown: ["predicate", "limit"],
      ordering: "stable",
      revisions: true,
      transactions: "none",
    },
  });
  const diagnostic = defineDiagnostic({
    code: "memory.invalid-fixture",
    severity: "error",
    message: "The fixture is invalid.",
    locations: [
      {
        kind: "node",
        node: { adapter: "memory", resource: "fixture", local: "root" },
      },
    ],
    notes: ["Use a root fixture."],
  });

  for (const value of [resource, edge, schema, diagnostic]) {
    assert(Object.isFrozen(value));
  }
  assert(Object.isFrozen(schema.kinds));
  assert(Object.isFrozen(schema.kinds[0]?.attributes));
  assert(Object.isFrozen(diagnostic.locations));
});

test("schema definitions enforce namespace ownership and one default tree", () => {
  assert.throws(
    () =>
      defineAdapterSchema({
        namespace: "memory",
        version: "1.0.0",
        dynamic: true,
        kinds: [],
        edges: [],
        operations: [],
        treeViews: [
          {
            name: "other::tree",
            rootKinds: [],
            childEdges: [],
            default: true,
          },
        ],
        capabilities: {
          traversal: [],
          pushdown: [],
          ordering: "unknown",
          revisions: false,
          transactions: "none",
        },
      }),
    /namespace memory/,
  );
});
