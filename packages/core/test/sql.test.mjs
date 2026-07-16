import assert from "node:assert/strict";
import test from "node:test";

import {
  applyChangePlan,
  createSqlAdapter,
  fromAdapter,
  fromSqlRows,
  fromValues,
  planOperations,
  sqlDeleteRows,
  sqlUpdateRows,
  validateAdapter,
} from "@mirek/ast";

const catalog = {
  server: "local",
  database: "app",
  version: "catalog:1",
  schemas: [{
    name: "public",
    tables: [
      {
        name: "users",
        columns: [
          { name: "id", scalar: "number", nullable: false },
          { name: "name", scalar: "string", nullable: false },
          { name: "score", scalar: "number", nullable: false },
          { name: "version", scalar: "number", nullable: false },
        ],
        primaryKey: ["id"],
        revisionColumn: "version",
        estimatedRows: 1_000_000,
      },
      {
        name: "flags",
        columns: [
          { name: "user_id", scalar: "number", nullable: false },
          { name: "enabled", scalar: "boolean", nullable: false },
        ],
        primaryKey: ["user_id"],
      },
      {
        name: "events",
        columns: [{ name: "message", scalar: "string", nullable: false }],
      },
    ],
  }],
  relations: [{
    name: "flags_user",
    from: { schema: "public", table: "flags", columns: ["user_id"] },
    to: { schema: "public", table: "users", columns: ["id"] },
  }],
};

const fakeClient = (initialRows = []) => {
  const state = {
    rows: initialRows,
    requests: [],
    transactions: [],
    produced: 0,
    closed: 0,
    version: catalog.version,
    affectedRows: 1,
  };
  return {
    state,
    client: {
      query(request, { signal } = {}) {
        state.requests.push(request);
        return {
          async *[Symbol.asyncIterator]() {
            try {
              for (const row of state.rows) {
                signal?.throwIfAborted();
                state.produced += 1;
                yield row;
              }
            } finally {
              state.closed += 1;
            }
          },
        };
      },
      catalogVersion: async () => state.version,
      transaction: async (statements) => {
        state.transactions.push(statements);
        return statements.map(() => ({ affectedRows: state.affectedRows }));
      },
    },
  };
};

const setup = (rows = []) => {
  const fixture = fakeClient(rows);
  return {
    ...fixture,
    adapter: createSqlAdapter({
      uri: "sql://local/app",
      catalog,
      client: fixture.client,
    }),
  };
};

test("SQL catalog nodes expose containment and relation references without scanning rows", async () => {
  const { adapter, state } = setup();
  assert.doesNotThrow(() => validateAdapter(adapter));
  const nodes = await fromAdapter(adapter, { uri: "sql://local/app" })
    .traverse({ roles: ["child", "reference"], maxDepth: 6, includeSelf: true })
    .toArray();
  assert.deepEqual(new Set(nodes.map(({ snapshot }) => snapshot.kind)), new Set([
    "sql::server", "sql::database", "sql::schema", "sql::table", "sql::column", "sql::relation",
  ]));
  const relation = nodes.find(({ snapshot }) => snapshot.kind === "sql::relation");
  assert(relation);
  const references = [];
  for await (const edge of relation.edges({ roles: ["reference"] })) references.push(edge.name);
  assert.deepEqual(references, ["sql::from", "sql::to"]);
  assert.equal(state.requests.length, 0);
});

test("row scans stream lazily and compile adversarial values as parameters", async () => {
  const attack = "x' OR 1=1; DROP TABLE users; --";
  const { adapter, state } = setup([
    { id: 1, name: "one", score: 1, version: 1 },
    { id: 2, name: "two", score: 2, version: 1 },
    { id: 3, name: "three", score: 3, version: 1 },
  ]);
  const query = fromSqlRows(adapter, {
    table: { schema: "public", name: "users" },
    select: ["id", "name"],
    where: { kind: "comparison", column: "name", operator: "=", value: attack },
    orderBy: [{ column: "id", direction: "asc" }],
  }).take(2);
  const rows = await query.toArray();
  assert.deepEqual(rows.map(({ snapshot }) => snapshot.attributes.id), [1, 2]);
  assert.equal(rows[0].snapshot.attributes["_identity"], "primary-key");
  assert.equal(rows[0].snapshot.attributes["_revision"], 1);
  assert.equal(state.produced, 2);
  assert.equal(state.closed, 1);
  assert.match(state.requests[0].text, /"name" = \$1/);
  assert.equal(state.requests[0].text.includes(attack), false);
  assert.deepEqual(state.requests[0].parameters, [attack]);
  assert.match(query.explain().physical.inputs[0].details.pushdown, /predicate,projection,sort/);

  assert.throws(
    () => fromSqlRows(adapter, {
      table: { schema: "public", name: "users" },
      select: ['name"; DROP TABLE users; --'],
    }),
    /Unknown SQL column/,
  );
  assert.throws(
    () => fromSqlRows(adapter, {
      table: { schema: "public", name: "users" },
      where: { kind: "comparison", column: "id", operator: "= 1; DROP TABLE users; --", value: 1 },
    }),
    /Unsupported SQL comparison operator/,
  );
  assert.throws(
    () => fromSqlRows(adapter, {
      table: { schema: "public", name: "users" },
      where: { kind: "comparison", column: "id", operator: "=", value: Number.NaN },
    }),
    /finite/,
  );

  const keyless = setup([{ message: "observed" }]);
  const [event] = await fromSqlRows(keyless.adapter, {
    table: { schema: "public", name: "events" },
  }).toArray();
  assert.equal(event.snapshot.attributes["_identity"], "query-ordinal");
  assert.match(event.snapshot.id.local, /^row:[A-Za-z0-9_-]+:0$/);
});

test("safe projection, aggregation, ordering, limits, and native joins are visible in SQL", async () => {
  const aggregateFixture = setup([{ count: 3 }]);
  const aggregate = fromSqlRows(aggregateFixture.adapter, {
    table: { schema: "public", name: "users" },
    where: { kind: "comparison", column: "score", operator: ">", value: 0 },
    aggregate: { function: "count", as: "count" },
    limit: 1,
  });
  const [count] = await aggregate.toArray();
  assert.equal(count.snapshot.kind, "sql::aggregate");
  assert.equal(count.snapshot.attributes.value, 3);
  assert.match(aggregateFixture.state.requests[0].text, /COUNT\(\*\) AS "count"/);
  assert.match(aggregateFixture.state.requests[0].text, /LIMIT \$2/);

  const joinFixture = setup([{ id: 1, name: "one", enabled: true }]);
  const native = fromSqlRows(joinFixture.adapter, {
    table: { schema: "public", name: "users" },
    joins: [{
      kind: "inner",
      table: { schema: "public", name: "flags" },
      on: { left: "id", right: "user_id" },
    }],
    select: ["name", { table: "flags", column: "enabled" }],
  });
  assert.equal((await native.toArray())[0].snapshot.attributes.enabled, true);
  assert.match(joinFixture.state.requests[0].text, /INNER JOIN "public"\."flags" AS "flags"/);
  assert.match(native.explain().physical.details.pushdown, /join/);

  const runtime = fromValues([{ id: 1, name: "one" }]).join(
    fromValues([{ user_id: 1, configured: true }]),
    { leftKey: ({ id }) => id, rightKey: ({ user_id }) => user_id },
  );
  assert.equal((await runtime.toArray())[0][1].configured, true);
  assert.equal(runtime.explain().physical.operator, "join");
  assert.equal(runtime.explain().physical.buffering, true);
});

test("unsupported callback predicates fall back before limits without changing semantics", async () => {
  const { adapter, state } = setup([
    { id: 0, name: "zero", score: 0, version: 1 },
    { id: 1, name: "one", score: 1, version: 1 },
    { id: 2, name: "two", score: 2, version: 1 },
    { id: 3, name: "three", score: 3, version: 1 },
    { id: 4, name: "four", score: 4, version: 1 },
  ]);
  const query = fromSqlRows(adapter, {
    table: { schema: "public", name: "users" },
    select: ["id", "score"],
    runtimePredicate: ({ score }) => typeof score === "number" && score >= 2,
    limit: 2,
  });
  assert.deepEqual((await query.toArray()).map(({ snapshot }) => snapshot.attributes.id), [2, 3]);
  assert.equal(state.produced, 4);
  assert.equal(state.closed, 1);
  assert.equal(state.requests[0].text.includes("LIMIT"), false);
  assert.equal(query.explain().physical.operator, "take");
  assert.equal(query.explain().physical.inputs[0].operator, "filter");
  assert.match(query.explain().physical.inputs[0].inputs[0].details.fallback, /predicate,limit/);
});

test("SQL mutations plan purely and apply in explicit optimistic transactions", async () => {
  const attack = "new', admin = true --";
  const { adapter, state } = setup();
  const target = {
    resource: "app",
    table: { schema: "public", name: "users" },
    where: { kind: "comparison", column: "id", operator: "=", value: 1 },
    concurrency: { kind: "optimistic", column: "version", expected: 7, expectedRows: 1 },
  };
  const plan = await planOperations([{
    id: "update-user",
    adapter,
    operation: sqlUpdateRows(adapter, target, { name: attack }),
  }]);
  assert.equal(state.transactions.length, 0);
  assert.equal(plan.changes[0].risk, "irreversible");
  assert.deepEqual(plan.transactionGroups.map(({ atomic, rollback, partialApplication }) => ({ atomic, rollback, partialApplication })), [{
    atomic: true,
    rollback: "adapter",
    partialApplication: "none",
  }]);
  assert.equal(plan.changes[0].payload.concurrency, "optimistic");
  assert.equal(plan.changes[0].payload.request.text.includes(attack), false);
  assert.deepEqual(plan.changes[0].payload.request.parameters, [attack, 1, 7]);

  const applied = await applyChangePlan(plan, [adapter]);
  assert.equal(applied.appliedChanges, 1);
  assert.equal(state.transactions.length, 1);

  state.affectedRows = 0;
  const conflicted = await applyChangePlan(plan, [adapter]);
  assert.equal(conflicted.groups[0].status, "failed");
  assert.match(conflicted.diagnostics[0].message, /expected 1 affected rows/);
  state.affectedRows = 1;

  state.version = "catalog:2";
  const stale = await applyChangePlan(plan, [adapter]);
  assert.equal(stale.groups[0].status, "failed");
  assert.match(stale.diagnostics[0].message, /catalog revision/);

  const deleteOperation = sqlDeleteRows(adapter, {
    resource: "app",
    table: { schema: "public", name: "events" },
    where: { kind: "comparison", column: "message", operator: "=", value: attack },
    concurrency: { kind: "transaction" },
  });
  const deletePlan = await planOperations([{ id: "delete-events", adapter, operation: deleteOperation }]);
  assert.equal(deletePlan.changes[0].payload.concurrency, "transaction");
  assert.equal(deletePlan.changes[0].payload.request.text.includes(attack), false);
});
