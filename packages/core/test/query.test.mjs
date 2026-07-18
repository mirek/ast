import assert from "node:assert/strict";
import test from "node:test";

import {
  capture,
  count,
  createInMemoryAdapter,
  distinct,
  filter,
  flatMap,
  fromAdapter,
  fromValues,
  groupBy,
  join,
  project,
  sort,
  take,
  traverse,
} from "@mirek/ast";

const node = (local, kind = "memory::node", attributes = {}) => ({
  id: { adapter: "memory", resource: "fixture", local },
  kind,
  attributes,
  origin: { uri: `memory:fixture#${local}`, revision: "1" },
});

const edge = (from, to, ordinal, role = "child", name = "memory::children") => ({
  name,
  role,
  from: node(from).id,
  to: node(to).id,
  ordinal,
});

const treeFixture = () => ({
  resource: {
    id: "fixture",
    adapter: "memory",
    uri: "memory:fixture",
    revision: "1",
  },
  ordering: "stable",
  roots: ["root", "root"],
  nodes: [
    node("root", "memory::root", { name: "root" }),
    node("a", "memory::node", { name: "a", group: "odd" }),
    node("b", "memory::node", { name: "b", group: "even" }),
    node("c", "memory::node", { name: "c", group: "odd" }),
  ],
  edges: [
    edge("root", "a", 0),
    edge("root", "b", 1),
    edge("a", "c", 0),
    edge("c", "root", 0, "reference", "memory::back"),
  ],
});

test("logical operators preserve bags, captures, and deterministic ordering", async () => {
  const adapter = createInMemoryAdapter(treeFixture());
  const roots = fromAdapter(adapter, { uri: "memory:fixture" });

  assert.equal(roots.ordering, "stable");
  assert.deepEqual(
    await roots.project((root) => root.snapshot.id.local).toArray(),
    ["root", "root"],
  );
  assert.deepEqual(
    await roots
      .distinct((root) => root.snapshot.id.local)
      .project((root) => root.snapshot.id.local)
      .toArray(),
    ["root"],
  );

  const descendants = roots
    .distinct((root) => root.snapshot.id.local)
    .capture("root")
    .traverse({ roles: ["child"], maxDepth: 2 })
    .filter((value) => value.snapshot.attributes.group === "odd")
    .project((value, captures) => ({
      root: captures.root.snapshot.id.local,
      value: value.snapshot.id.local,
    }));

  assert.deepEqual(await descendants.toArray(), [
    { root: "root", value: "a" },
    { root: "root", value: "c" },
  ]);

  const cycle = traverse(roots.distinct((value) => value.snapshot.id.local), {
    edgeNames: ["memory::back", "memory::children"],
    maxDepth: 4,
  });
  assert.equal((await cycle.toArray()).length, 6);
});

test("projection callbacks receive the active execution context", async () => {
  const controller = new AbortController();
  const projected = project(
    fromValues(["value"]),
    (value, _captures, options) => ({ value, sameSignal: options.signal === controller.signal }),
  );
  assert.deepEqual(await projected.toArray({ signal: controller.signal }), [
    { value: "value", sameSignal: true },
  ]);
});

test("functional and fluent APIs build the same logical query", async () => {
  const source = fromValues([3, 1, 2, 2], { ordering: "stable", label: "numbers" });
  const functional = project(
    take(distinct(filter(source, (value) => value > 1)), 2),
    (value) => value * 10,
  );
  const fluent = source
    .filter((value) => value > 1)
    .distinct()
    .take(2)
    .project((value) => value * 10);

  assert.deepEqual(functional.explain(), fluent.explain());
  assert.deepEqual(await functional.toArray(), [30, 20]);
});

test("projection, flat mapping, counting, grouping, and joining compose", async () => {
  const values = fromValues([1, 2, 3]);
  assert.deepEqual(await flatMap(values, (value) => [value, -value]).toArray(), [
    1,
    -1,
    2,
    -2,
    3,
    -3,
  ]);
  assert.deepEqual(await count(values).toArray(), [3]);

  const groups = await groupBy(values, (value) => value % 2).toArray();
  assert.deepEqual(groups, [
    { key: 1, values: [1, 3] },
    { key: 0, values: [2] },
  ]);

  const joined = join(fromValues([1, 2, 3]), fromValues([2, 3, 4]), {
    leftKey: (value) => value,
    rightKey: (value) => value,
  });
  assert.deepEqual(await joined.toArray(), [
    [1 + 1, 2],
    [2 + 1, 3],
  ]);
});

test("take stops upstream without materializing the source", async () => {
  let produced = 0;
  let returned = false;
  const source = fromValues(
    async function* () {
      try {
        while (true) {
          produced += 1;
          yield produced;
        }
      } finally {
        returned = true;
      }
    },
    { label: "infinite" },
  );

  assert.deepEqual(await take(source, 2).toArray(), [1, 2]);
  assert.equal(produced, 2);
  assert.equal(returned, true);
});

test("physical explain identifies only buffering operators", () => {
  const source = fromValues([3, 2, 1]);
  const streaming = source.filter(() => true).take(1).count();
  const buffered = sort(streaming, (a, b) => a - b);

  assert.equal(streaming.explain().physical.buffering, false);
  assert.equal(buffered.explain().physical.buffering, true);
  assert.equal(buffered.explain().physical.operator, "sort");
});

test("abort and consumer cancellation close every opened resource", async () => {
  const adapter = createInMemoryAdapter(treeFixture());
  const query = fromAdapter(adapter, { uri: "memory:fixture" });
  const iterator = query[Symbol.asyncIterator]();

  await iterator.next();
  await iterator.return();
  assert.deepEqual(adapter.statistics(), {
    opened: 1,
    closed: 1,
    rootsRead: 1,
    edgesRead: 0,
    hydrated: 0,
  });

  const controller = new AbortController();
  const aborted = fromAdapter(adapter, { uri: "memory:fixture" }).filter((value) => {
    controller.abort(new Error(`stop at ${value.snapshot.id.local}`));
    return true;
  });
  await assert.rejects(aborted.toArray({ signal: controller.signal }), /stop at root/);
  assert.equal(adapter.statistics().opened, 2);
  assert.equal(adapter.statistics().closed, 2);
});

test("execution errors close opened resources", async () => {
  const adapter = createInMemoryAdapter(treeFixture());
  const query = fromAdapter(adapter, { uri: "memory:fixture" }).filter(() => {
    throw new Error("predicate failed");
  });

  await assert.rejects(query.toArray(), /predicate failed/);
  assert.equal(adapter.statistics().opened, 1);
  assert.equal(adapter.statistics().closed, 1);
});

test("unknown source ordering is retained until an explicit sort", () => {
  const adapter = createInMemoryAdapter({ ...treeFixture(), ordering: "unknown" });
  const source = fromAdapter(adapter, { uri: "memory:fixture" });

  assert.equal(source.filter(() => true).ordering, "unknown");
  assert.equal(
    sort(source, (a, b) => a.snapshot.id.local.localeCompare(b.snapshot.id.local)).ordering,
    "stable",
  );
});

test("functional capture is visible only to downstream callbacks", async () => {
  const source = capture(fromValues([1, 2]), "original");
  const result = project(source, (value, captures) => value + captures.original);

  assert.deepEqual(await result.toArray(), [2, 4]);
});
