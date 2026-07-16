import assert from "node:assert/strict";
import test from "node:test";

import {
  defineAdapterSchema,
  deserializeChangePlan,
  fromAdapter,
  planOperations,
  registerPlugins,
  serializeChangePlan,
} from "@mirek/ast";

const manifest = (overrides = {}) => ({
  apiVersion: "1",
  name: "@example/ast-plugin",
  version: "1.2.3",
  integrity: "sha256:example-build-1",
  namespaces: ["example"],
  powers: ["resource:read"],
  contributions: {
    adapters: ["example"],
    schemas: ["example"],
    resolvers: ["example::source"],
    mounts: ["example::mount"],
    operations: ["example::noop"],
    predicates: ["example::truthy"],
    functions: ["example::identity"],
    renderers: ["example::text"],
    diffProviders: ["example::diff"],
    optimizerRules: ["example::identity-rule"],
  },
  ...overrides,
});

const moduleFor = (manifestValue = manifest()) => {
  const schema = defineAdapterSchema({
    namespace: "example",
    version: "3.0.0",
    dynamic: true,
    kinds: [{
      kind: "example::item",
      attributes: { index: { scalar: "number", cardinality: "one", required: true } },
      identity: { stability: "observation", description: "Fixture item index." },
    }],
    edges: [],
    operations: [{ kind: "example::noop", arguments: {} }],
    treeViews: [{ name: "example::tree", rootKinds: ["example::item"], childEdges: [], default: true }],
    capabilities: {
      traversal: ["tree"],
      pushdown: [],
      ordering: "unknown",
      revisions: false,
      transactions: "none",
      semanticOperations: true,
    },
  });
  const adapter = {
    contractVersion: "1",
    namespace: "example",
    schema,
    read: {
      open: async (source) => ({
        resource: { id: "fixture", adapter: "example", uri: source.uri },
        close: async () => {},
      }),
      roots: async function* (resource) {
        for (let index = 0; index < 2; index += 1) {
          yield {
            id: { adapter: "example", resource: resource.id, local: String(index) },
            kind: "example::item",
            attributes: { index },
          };
        }
      },
      edges: async function* () {},
      hydrate: async () => [],
    },
    planning: { plan: async () => [] },
  };
  return {
    manifest: manifestValue,
    contributions: {
      adapters: [adapter],
      schemas: [schema],
      resolvers: [{ name: "example::source", adapter, open: () => fromAdapter(adapter, { uri: "example:fixture" }) }],
      mounts: [{ name: "example::mount", adapter, mount: (query) => query }],
      operations: [{
        name: "example::noop",
        adapter,
        create: (target) => ({
          kind: "example::noop",
          resource: target.snapshot.id.resource,
          target: target.snapshot.id,
          payload: {},
        }),
      }],
      predicates: [{ name: "example::truthy", test: (value) => Boolean(value) }],
      functions: [{ name: "example::identity", call: ([value]) => value }],
      renderers: [{ name: "example::text", render: (value) => String(value) }],
      diffProviders: [{ name: "example::diff", render: (before, after) => `${before} -> ${after}` }],
      optimizerRules: [{ name: "example::identity-rule", equivalence: "identity" }],
    },
  };
};

const policy = (overrides = {}) => ({
  allow: ["@example/ast-plugin"],
  powers: { "@example/ast-plugin": ["resource:read"] },
  aliases: {
    namespaces: { ex: "example" },
    sources: { demo: "example::source" },
    mounts: { demo: "example::mount" },
    operations: { noop: "example::noop" },
  },
  ...overrides,
});

test("plugin registration validates manifests and exposes only explicit aliases", async () => {
  const registry = registerPlugins([moduleFor()], policy());
  assert.equal(Object.isFrozen(registry.plugins), true);
  assert.deepEqual(registry.plugins.map(({ name, version }) => [name, version]), [
    ["@example/ast-plugin", "1.2.3"],
  ]);
  assert.deepEqual(registry.adapters[0].plugin, {
    apiVersion: "1",
    name: "@example/ast-plugin",
    version: "1.2.3",
    integrity: "sha256:example-build-1",
  });
  assert.equal(registry.schemas.example.dynamic, true);
  assert.equal(registry.aliases.namespaces.ex, "example");
  assert.equal(registry.resolvers["example::source"].adapter, registry.adapters[0]);
  assert.equal(registry.dslEnvironment.sources.demo.adapter, registry.adapters[0]);
  assert.equal((await registry.dslEnvironment.sources.demo.open([]).toArray()).length, 2);
  assert.equal(registry.predicates["example::truthy"].test(1, []), true);
  assert.equal(registry.optimizerRules["example::identity-rule"].equivalence, "identity");
});

test("unknown, duplicate, incompatible, unauthorized, and unsafe plugins fail before use", () => {
  assert.throws(
    () => registerPlugins([], policy()),
    (error) => error.code === "plugin.unknown",
  );
  assert.throws(
    () => registerPlugins([moduleFor(), moduleFor()], policy()),
    (error) => error.code === "plugin.duplicate",
  );
  assert.throws(
    () => registerPlugins([moduleFor(manifest({ apiVersion: "2" }))], policy()),
    (error) => error.code === "plugin.incompatible-api",
  );
  assert.throws(
    () => registerPlugins([moduleFor()], policy({ powers: {} })),
    (error) => error.code === "plugin.unauthorized-power",
  );
  assert.throws(
    () => registerPlugins([moduleFor()], policy({ reservedNamespaces: ["example"] })),
    (error) => error.code === "plugin.duplicate-namespace",
  );
  assert.throws(
    () => registerPlugins([moduleFor()], policy({ aliases: { sources: { demo: "missing::source" } } })),
    (error) => error.code === "plugin.unknown-alias-target",
  );
  const unsafe = moduleFor();
  unsafe.contributions.optimizerRules[0] = {
    name: "example::identity-rule",
    equivalence: "drop-filter",
  };
  assert.throws(
    () => registerPlugins([unsafe], policy()),
    (error) => error.code === "plugin.invalid-optimizer-rule",
  );
  const staticSchema = moduleFor();
  staticSchema.contributions.schemas[0] = {
    ...staticSchema.contributions.schemas[0],
    dynamic: false,
  };
  assert.throws(
    () => registerPlugins([staticSchema], policy()),
    (error) => error.code === "plugin.static-schema",
  );
  const mismatchedSchema = moduleFor();
  mismatchedSchema.contributions.schemas[0] = {
    ...mismatchedSchema.contributions.schemas[0],
    version: "4.0.0",
  };
  assert.throws(
    () => registerPlugins([mismatchedSchema], policy()),
    (error) => error.code === "plugin.schema-mismatch",
  );
});

test("saved plans bind plugin package, version, integrity, and schema identity", async () => {
  const registry = registerPlugins([moduleFor()], policy());
  const plan = await planOperations([{
    id: "plugin-operation",
    adapter: registry.adapters[0],
    operation: { kind: "example::noop", resource: "fixture", payload: {} },
  }]);
  assert.deepEqual(plan.adapters[0], {
    namespace: "example",
    schemaVersion: "3.0.0",
    plugin: {
      apiVersion: "1",
      name: "@example/ast-plugin",
      version: "1.2.3",
      integrity: "sha256:example-build-1",
    },
  });
  const saved = serializeChangePlan(plan);
  assert.deepEqual(deserializeChangePlan(saved, { adapters: registry.adapters }), plan);

  const replacementManifest = manifest({ version: "1.2.4", integrity: "sha256:example-build-2" });
  const replacement = registerPlugins(
    [moduleFor(replacementManifest)],
    policy({ powers: { "@example/ast-plugin": ["resource:read"] } }),
  );
  assert.throws(
    () => deserializeChangePlan(saved, { adapters: replacement.adapters }),
    /plugin identity/,
  );
});
