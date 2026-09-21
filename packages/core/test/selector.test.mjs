import assert from "node:assert/strict";
import test from "node:test";

import {
  SelectorError,
  createInMemoryAdapter,
  fromAdapter,
  select,
} from "@mirek/ast";

const node = (local, kind, attributes = {}) => ({
  id: { adapter: "memory", resource: "selectors", local },
  kind,
  attributes,
  origin: { uri: `memory:selectors#${local}`, revision: "1" },
});

const edge = (from, to, ordinal, role = "child", name = "memory::children") => ({
  name,
  role,
  from: node(from, "memory::node").id,
  to: node(to, "memory::node").id,
  ordinal,
});

const fixture = (ordering = "stable") => ({
  resource: {
    id: "selectors",
    adapter: "memory",
    uri: "memory:selectors",
    revision: "1",
  },
  ordering,
  roots: ["root", "root"],
  nodes: [
    node("root", "memory::root", { name: "root" }),
    node("alpha", "memory::item", {
      name: "alpha",
      active: true,
      nullable: null,
      tags: ["selected", "first"],
    }),
    node("beta", "memory::item", { name: "beta", active: false, tags: ["second"] }),
    node("alpha-leaf", "memory::leaf", { name: "alpha", score: 3 }),
    node("beta-leaf", "memory::leaf", { name: "beta", score: 1 }),
    node("target", "memory::target", { name: "target" }),
  ],
  edges: [
    edge("root", "alpha", 0),
    edge("root", "beta", 1),
    edge("root", "target", 2),
    edge("alpha", "alpha-leaf", 0),
    edge("beta", "beta-leaf", 0),
    edge("alpha", "target", 0, "reference", "memory::link"),
  ],
});

const ids = async (query) =>
  query.project((value) => value.snapshot.id.local).toArray();

test("selectors compile to the query algebra with typed predicates and bag semantics", async () => {
  const adapter = createInMemoryAdapter(fixture());
  const source = { uri: "memory:selectors" };

  const selected = select(
    adapter,
    source,
    'memory::item[name ^= "a"] > memory::leaf[score >= 2]',
  );
  const equivalent = fromAdapter(adapter, source)
    .traverse({ roles: ["child"], maxDepth: Number.MAX_SAFE_INTEGER, includeSelf: true })
    .filter((value) => value.snapshot.kind === "memory::item")
    .filter((value) => value.snapshot.attributes.name.startsWith("a"))
    .flatMap(async function* (value) {
      for await (const candidate of value.edges({ roles: ["child"] })) {
        const child = await value.resolve(candidate.to);
        if (child !== undefined) yield child;
      }
    })
    .filter(
      (value) =>
        value.snapshot.kind === "memory::leaf" && value.snapshot.attributes.score >= 2,
    );

  assert.deepEqual(await ids(selected), await ids(equivalent));
  assert.deepEqual(await ids(selected), ["alpha-leaf", "alpha-leaf"]);
  assert.equal(selected.explain().logical.operator, "filter");
});

test("separate graph paths retain duplicate nodes until distinct is explicit", async () => {
  const graph = fixture();
  const adapter = createInMemoryAdapter({
    ...graph,
    roots: ["root"],
    nodes: [...graph.nodes, node("shared", "memory::leaf", { name: "shared" })],
    edges: [
      ...graph.edges,
      edge("alpha", "shared", 1),
      edge("beta", "shared", 1),
    ],
  });
  const selected = select(
    adapter,
    { uri: "memory:selectors" },
    'memory::leaf[name = "shared"]',
  );

  assert.deepEqual(await ids(selected), ["shared", "shared"]);
  assert.deepEqual(await ids(selected.distinct()), ["shared"]);
});

test("predicates distinguish missing and null and support membership, regex, and pseudos", async () => {
  const adapter = createInMemoryAdapter(fixture());
  const source = { uri: "memory:selectors" };

  assert.deepEqual(
    await ids(
      select(
        adapter,
        source,
        'memory::item:is([name in ("alpha", "other")], [name ~= /^bet/]):not([active = false])',
      ),
    ),
    ["alpha", "alpha"],
  );
  assert.deepEqual(
    await ids(select(adapter, source, "memory::item[nullable is null][unknown is missing]")),
    ["alpha", "alpha"],
  );
  assert.deepEqual(
    await ids(select(adapter, source, "memory::item:has(> memory::leaf[score >= 2])")),
    ["alpha", "alpha"],
  );
  assert.deepEqual(
    await ids(select(adapter, source, 'memory::item[tags *= "selected"]')),
    ["alpha", "alpha"],
  );
});

test("selectors traverse descendants, ordered siblings, named edges, and captures", async () => {
  const adapter = createInMemoryAdapter(fixture());
  const source = { uri: "memory:selectors" };

  assert.deepEqual(
    await ids(select(adapter, source, "memory::root memory::leaf")),
    ["alpha-leaf", "beta-leaf", "alpha-leaf", "beta-leaf"],
  );
  assert.deepEqual(
    await ids(select(adapter, source, "memory::item + memory::item")),
    ["beta", "beta"],
  );
  assert.deepEqual(
    await ids(select(adapter, source, "memory::item ~ memory::item")),
    ["beta", "beta"],
  );
  assert.deepEqual(
    await ids(select(adapter, source, "memory::item ->memory::link memory::target")),
    ["target", "target"],
  );
  assert.deepEqual(
    await ids(select(adapter, source, "memory::target <-memory::link memory::item")),
    ["alpha", "alpha"],
  );

  const captured = select(
    adapter,
    source,
    "memory::item as $item > memory::leaf[name = $item.name] as $leaf",
  ).project((value, captures) => ({
    item: captures.item.snapshot.id.local,
    leaf: captures.leaf.snapshot.id.local,
    value: value.snapshot.id.local,
  }));
  assert.deepEqual(await captured.toArray(), [
    { item: "alpha", leaf: "alpha-leaf", value: "alpha-leaf" },
    { item: "beta", leaf: "beta-leaf", value: "beta-leaf" },
    { item: "alpha", leaf: "alpha-leaf", value: "alpha-leaf" },
    { item: "beta", leaf: "beta-leaf", value: "beta-leaf" },
  ]);
});

test("invalid selectors produce stable source-ranged diagnostics", () => {
  const adapter = createInMemoryAdapter(fixture());
  const source = { uri: "memory:selectors" };
  const invalid = [
    ["item", "selector.ambiguous-name"],
    ["memory::missing", "selector.unknown-kind"],
    ["memory::item[nope = 1]", "selector.unknown-attribute"],
    ['memory::item[active = "true"]', "selector.type-mismatch"],
    ["memory::item[active < true]", "selector.invalid-comparison"],
    ["memory::item ->memory::missing memory::target", "selector.unknown-edge"],
    ['memory::item[name = $missing.name]', "selector.unknown-capture"],
    ["memory::item as $item as $item", "selector.duplicate-capture"],
  ];

  for (const [selector, code] of invalid) {
    assert.throws(
      () => select(adapter, source, selector, { uri: "query.ast" }),
      (error) => {
        assert(error instanceof SelectorError);
        assert.equal(error.diagnostics[0]?.code, code);
        assert.equal(error.diagnostics[0]?.locations[0]?.kind, "program");
        assert.equal(error.diagnostics[0]?.locations[0]?.uri, "query.ast");
        assert.equal(error.diagnostics[0]?.locations[0]?.range?.start >= 0, true);
        return true;
      },
    );
  }
});

test("sibling selectors reject sources without declared order", () => {
  const adapter = createInMemoryAdapter(fixture("unknown"));

  assert.throws(
    () => select(adapter, { uri: "memory:selectors" }, "memory::item + memory::item"),
    (error) => {
      assert(error instanceof SelectorError);
      assert.equal(error.diagnostics[0]?.code, "selector.unordered-sibling");
      return true;
    },
  );
});

test("selector edge reads propagate cancellation and close the source", async () => {
  const adapter = createInMemoryAdapter(fixture());
  const controller = new AbortController();
  const query = select(
    adapter,
    { uri: "memory:selectors" },
    "memory::item ->memory::link memory::target",
  ).filter(() => {
    controller.abort(new Error("stop selector"));
    return true;
  });

  await assert.rejects(query.toArray({ signal: controller.signal }), /stop selector/);
  assert.equal(adapter.statistics().opened, 1);
  assert.equal(adapter.statistics().closed, 1);
});

test('parent and ancestor selectors use containment, preserve captures, and work in relative predicates', async () => {
  const adapter = createInMemoryAdapter(fixture());
  const source = { uri: 'memory:selectors' };
  assert.deepEqual(await ids(select(adapter, source, 'memory::leaf[name = "alpha"] < memory::item')), ['alpha', 'alpha']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::leaf << memory::root')), ['root', 'root', 'root', 'root']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::leaf:has(< memory::item[name = "beta"])')), ['beta-leaf', 'beta-leaf']);
  const rows = await select(adapter, source, 'memory::leaf as $leaf << memory::root')
    .project((root, captures) => [captures.leaf.snapshot.id.local, root.snapshot.id.local]).toArray();
  assert.deepEqual(rows, [['alpha-leaf', 'root'], ['beta-leaf', 'root'], ['alpha-leaf', 'root'], ['beta-leaf', 'root']]);
  assert.equal(adapter.statistics().opened, adapter.statistics().closed);
});

test('path cycle pruning terminates traversal without collapsing distinct containment paths', async () => {
  const graph = fixture();
  graph.roots = ['root'];
  graph.edges.push(edge('alpha', 'root', 1), edge('beta', 'alpha-leaf', 1));
  const adapter = createInMemoryAdapter(graph);
  const query = fromAdapter(adapter, { uri: 'memory:selectors' }).traverse({ roles: ['child'], maxDepth: 4, cycle: 'prune' });
  assert.deepEqual(await ids(query), ['alpha', 'alpha-leaf', 'beta', 'beta-leaf', 'alpha-leaf', 'target']);
});

test('implicit selector tree expansion prunes cycles before evaluating ancestors', async () => {
  const graph = fixture();
  graph.roots = ['root'];
  graph.edges.push(edge('alpha', 'root', 1));
  const adapter = createInMemoryAdapter(graph);
  const query = select(adapter, { uri: 'memory:selectors' }, 'memory::leaf << memory::root').take(5);
  assert.deepEqual(await ids(query), ['root', 'root']);
});

test('reverse sibling selectors return previous nodes nearest first and preserve captures', async () => {
  const adapter = createInMemoryAdapter(fixture());
  const source = { uri: 'memory:selectors' };
  assert.deepEqual(await ids(select(adapter, source, 'memory::item[name = "beta"] <+ memory::item')), ['alpha', 'alpha']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::target <~ memory::item')), ['beta', 'alpha', 'beta', 'alpha']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::item[name = "alpha"] <+ memory::item')), []);
  assert.deepEqual(await ids(select(adapter, source, 'memory::item:has(<+ memory::item[name = "alpha"])')), ['beta', 'beta']);
  const rows = await select(adapter, source, 'memory::target as $start <~ memory::item')
    .project((item, captures) => [captures.start.snapshot.id.local, item.snapshot.id.local]).toArray();
  assert.deepEqual(rows, [['target', 'beta'], ['target', 'alpha'], ['target', 'beta'], ['target', 'alpha']]);
});

test('reverse siblings reject unordered containment before opening a source', () => {
  const adapter = createInMemoryAdapter(fixture('unknown'));
  for (const operator of ['<+', '<~']) {
    assert.throws(() => select(adapter, { uri: 'memory:selectors' }, `memory::item ${operator} memory::item`), error => error.diagnostics[0].code === 'selector.unordered-sibling');
  }
  assert.equal(adapter.statistics().opened, 0);
});

test('kind-qualified selectors reject attributes belonging only to a different kind', () => {
  const adapter = createInMemoryAdapter(fixture());
  assert.throws(() => select(adapter, { uri: 'memory:selectors' }, 'memory::item[score = 3]'), error => error.diagnostics[0].code === 'selector.unknown-attribute');
  assert.equal(adapter.statistics().opened, 0);
});

test('positional predicates count ordered children per parent including other node kinds', async () => {
  const adapter = createInMemoryAdapter(fixture());
  const source = { uri: 'memory:selectors' };
  assert.deepEqual(await ids(select(adapter, source, 'memory::item:first-child')), ['alpha', 'alpha']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::item:nth-child(2)')), ['beta', 'beta']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::item:last-child')), []);
  assert.deepEqual(await ids(select(adapter, source, 'memory::target:last-child')), ['target', 'target']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::item:nth-last-child(2)')), ['beta', 'beta']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::leaf:only-child')), ['alpha-leaf', 'beta-leaf', 'alpha-leaf', 'beta-leaf']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::root:first-child')), []);
  assert.deepEqual(await ids(select(adapter, source, 'memory::item:has(> memory::leaf:only-child)')), ['alpha', 'beta', 'alpha', 'beta']);
});

test('nth-child formulas support progressions without treating them as global result offsets', async () => {
  const adapter = createInMemoryAdapter(fixture());
  const source = { uri: 'memory:selectors' };
  assert.deepEqual(await ids(select(adapter, source, 'memory::item:nth-child(odd)')), ['alpha', 'alpha']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::item:nth-child(even)')), ['beta', 'beta']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::item:nth-child(-n + 2)')), ['alpha', 'beta', 'alpha', 'beta']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::item:nth-child(2n+1)')), ['alpha', 'alpha']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::item:nth-child(0)')), []);
});

test('position formulas and unordered parents fail validation before reading', () => {
  const adapter = createInMemoryAdapter(fixture());
  for (const formula of ['1.5', '1 2', 'n +', 'Infinity', '9007199254740992']) {
    assert.throws(() => select(adapter, { uri: 'memory:selectors' }, `memory::item:nth-child(${formula})`), error => error.diagnostics[0].code === 'selector.position-formula');
  }
  const unordered = createInMemoryAdapter(fixture('unknown'));
  assert.throws(() => select(unordered, { uri: 'memory:selectors' }, 'memory::item:first-child'), error => error.diagnostics[0].code === 'selector.unordered-position');
  assert.equal(adapter.statistics().opened, 0);
  assert.equal(unordered.statistics().opened, 0);
});

test('scope anchors each input node and remains stable through traversal and boolean predicates', async () => {
  const adapter = createInMemoryAdapter(fixture());
  const source = { uri: 'memory:selectors' };
  assert.deepEqual(await ids(select(adapter, source, ':scope')), ['root', 'root']);
  assert.deepEqual(await ids(select(adapter, source, ':scope > memory::item')), ['alpha', 'beta', 'alpha', 'beta']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::leaf << :scope')), ['root', 'root', 'root', 'root']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::item:not(:scope)')), ['alpha', 'beta', 'alpha', 'beta']);
  assert.deepEqual(await ids(select(adapter, source, ':is(:scope)')), ['root', 'root']);
  const captures = await select(adapter, source, ':scope as $root > memory::item')
    .project((_node, values) => Object.keys(values)).toArray();
  assert.deepEqual(captures, [['root'], ['root'], ['root'], ['root']]);
});

test('has scopes are local to their anchor and do not leak from nested predicates', async () => {
  const adapter = createInMemoryAdapter(fixture());
  const source = { uri: 'memory:selectors' };
  assert.deepEqual(await ids(select(adapter, source, 'memory::item:has(:scope > memory::leaf)')), ['alpha', 'beta', 'alpha', 'beta']);
  assert.deepEqual(await ids(select(adapter, source, 'memory::item:has(:scope > memory::leaf):not(:scope)')), ['alpha', 'beta', 'alpha', 'beta']);
  assert.deepEqual(await ids(select(adapter, source, ':scope:has(> memory::item:has(:scope > memory::leaf))')), ['root', 'root']);
});
