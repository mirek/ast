import { createHash } from "node:crypto";

import type {
  Adapter,
  ApplyContext,
  ApplyResult,
  Operation,
  PlanContext,
  ReadCapability,
} from "./adapter.js";
import type { Change } from "./change.js";
import { immutableCopy } from "./immutable.js";
import { defineEdge, defineNodeSnapshot, defineResource } from "./model.js";
import type {
  AttributeValue,
  Edge,
  EdgeRequest,
  NamespacedName,
  NodeId,
  NodeSnapshot,
  Resource,
} from "./model.js";
import { fromValues } from "./query.js";
import type { NavigableNodeHandle, Query } from "./query.js";
import { defineAdapterSchema } from "./schema.js";
import type { AttributeSchema, NodeKindSchema, ScalarType } from "./schema.js";

export type SqlValue = string | number | boolean | null;
export type SqlRow = Readonly<Record<string, SqlValue>>;
export type SqlColumnType = Exclude<ScalarType, "bigint">;

export interface SqlColumnCatalog {
  readonly name: string;
  readonly scalar: SqlColumnType;
  readonly nullable: boolean;
}

export interface SqlTableCatalog {
  readonly name: string;
  readonly columns: readonly SqlColumnCatalog[];
  readonly primaryKey?: readonly string[];
  readonly revisionColumn?: string;
  readonly estimatedRows?: number;
}

export interface SqlSchemaCatalog {
  readonly name: string;
  readonly tables: readonly SqlTableCatalog[];
}

export interface SqlTableReference {
  readonly schema: string;
  readonly name: string;
}

export interface SqlRelationEndpoint {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly string[];
}

export interface SqlRelationCatalog {
  readonly name: string;
  readonly from: SqlRelationEndpoint;
  readonly to: SqlRelationEndpoint;
}

export interface SqlCatalog {
  readonly server: string;
  readonly database: string;
  readonly version: string;
  readonly schemas: readonly SqlSchemaCatalog[];
  readonly relations?: readonly SqlRelationCatalog[];
}

export interface SqlQueryRequest {
  readonly text: string;
  readonly parameters: readonly SqlValue[];
}

export interface SqlStatementResult {
  readonly affectedRows: number;
}

export interface SqlClient {
  query(request: SqlQueryRequest, context?: { readonly signal?: AbortSignal }): AsyncIterable<SqlRow>;
  catalogVersion(context?: { readonly signal?: AbortSignal }): Promise<string>;
  transaction(
    statements: readonly SqlQueryRequest[],
    context?: { readonly signal?: AbortSignal },
  ): Promise<readonly SqlStatementResult[]>;
}

export interface SqlColumnReference {
  readonly table: string;
  readonly column: string;
}

export type SqlColumnSelection = string | SqlColumnReference;
export type SqlComparisonOperator = "=" | "!=" | "<" | "<=" | ">" | ">=" | "like";
export type SqlPredicate =
  | { readonly kind: "comparison"; readonly column: SqlColumnSelection; readonly operator: SqlComparisonOperator; readonly value: SqlValue }
  | { readonly kind: "in"; readonly column: SqlColumnSelection; readonly values: readonly SqlValue[] }
  | { readonly kind: "is-null"; readonly column: SqlColumnSelection; readonly not?: boolean }
  | { readonly kind: "and" | "or"; readonly predicates: readonly SqlPredicate[] }
  | { readonly kind: "not"; readonly predicate: SqlPredicate };

export interface SqlOrder {
  readonly column: SqlColumnSelection;
  readonly direction: "asc" | "desc";
}

export interface SqlJoin {
  readonly kind: "inner";
  readonly table: SqlTableReference;
  readonly on: { readonly left: string; readonly right: string };
}

export interface SqlAggregate {
  readonly function: "count" | "sum" | "min" | "max" | "avg";
  readonly column?: SqlColumnSelection;
  readonly as: string;
}

export interface SqlRowSource {
  readonly table: SqlTableReference;
  readonly select?: readonly SqlColumnSelection[];
  readonly where?: SqlPredicate;
  readonly joins?: readonly SqlJoin[];
  readonly orderBy?: readonly SqlOrder[];
  readonly aggregate?: SqlAggregate;
  readonly limit?: number;
  readonly offset?: number;
  readonly runtimePredicate?: (row: SqlRow) => boolean;
}

export interface SqlOptimisticConcurrency {
  readonly kind: "optimistic";
  readonly column: string;
  readonly expected: SqlValue;
  readonly expectedRows: number;
}

export interface SqlTransactionConcurrency { readonly kind: "transaction"; }
export interface SqlMutationTarget {
  readonly resource: string;
  readonly table: SqlTableReference;
  readonly where: SqlPredicate;
  readonly concurrency: SqlOptimisticConcurrency | SqlTransactionConcurrency;
}

export interface SqlUpdateRowsOperation extends Operation<"sql::update-rows", {
  readonly target: SqlMutationTarget;
  readonly values: Readonly<Record<string, SqlValue>>;
}> {}
export interface SqlDeleteRowsOperation extends Operation<"sql::delete-rows", {
  readonly target: SqlMutationTarget;
}> {}
export type SqlOperation = SqlUpdateRowsOperation | SqlDeleteRowsOperation;

export interface SqlChangePayload {
  readonly request: SqlQueryRequest;
  readonly concurrency: "optimistic" | "transaction";
  readonly expectedAffectedRows?: number;
}
export type SqlChange = Change<SqlChangePayload>;

export interface SqlStatistics {
  readonly metadataOpened: number;
  readonly metadataClosed: number;
  readonly queries: number;
  readonly rowsRead: number;
  readonly transactions: number;
  readonly statements: number;
}

export interface SqlAdapterOptions {
  readonly uri: string;
  readonly catalog: SqlCatalog;
  readonly client: SqlClient;
}

export interface SqlCompiledQuery {
  readonly request: SqlQueryRequest;
  readonly table: SqlTableCatalog;
  readonly tableReference: SqlTableReference;
  readonly outputColumns: readonly string[];
  readonly identityColumns: readonly string[];
  readonly revisionColumn?: string;
  readonly aggregate?: SqlAggregate;
  readonly pushdown: string;
  readonly fallback: string;
  readonly ordering: "stable" | "unknown";
}

export interface SqlAdapter extends Adapter {
  readonly namespace: "sql";
  readonly read: ReadCapability;
  readonly planning: { plan(operation: SqlOperation, context: PlanContext): Promise<readonly SqlChange[]> };
  readonly apply: { apply(changes: readonly SqlChange[], context: ApplyContext): Promise<ApplyResult> };
  compile(source: SqlRowSource): SqlCompiledQuery;
  scan(source: SqlRowSource, compiled: SqlCompiledQuery, signal?: AbortSignal): AsyncIterable<NavigableNodeHandle>;
  statistics(): SqlStatistics;
}

const reservedRowAttributes = new Set(["_table", "_identity", "_revision"]);
const tableKey = ({ schema, name }: SqlTableReference): string => `${schema}.${name}`;
const endpointTable = ({ schema, table }: SqlRelationEndpoint): SqlTableReference => ({ schema, name: table });
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const qualifiedTable = (table: SqlTableReference): string => `${quote(table.schema)}.${quote(table.name)}`;
const digest = (value: string): string => createHash("sha256").update(value).digest("base64url").slice(0, 16);
const comparisonOperators = new Set<SqlComparisonOperator>(["=", "!=", "<", "<=", ">", ">=", "like"]);
const columnTypes = new Set<SqlColumnType>(["string", "number", "boolean", "null"]);
function assertSqlValue(value: unknown): asserts value is SqlValue {
  if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new TypeError("SQL values must be scalar strings, finite numbers, booleans, or null.");
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("SQL numeric values must be finite.");
}
const nonEmpty = (label: string, value: string): void => {
  if (value.length === 0) throw new TypeError(`${label} must not be empty.`);
};
const matchesEdge = (edge: Edge, node: NodeId, request: EdgeRequest): boolean => {
  const endpoint = request.direction === "reverse" ? edge.to : edge.from;
  return endpoint.local === node.local && endpoint.resource === node.resource &&
    (request.names === undefined || request.names.includes(edge.name)) &&
    (request.roles === undefined || request.roles.includes(edge.role));
};

const natural = (label: string, value: number | undefined): void => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError(`${label} must be a non-negative safe integer.`);
};

const validateCatalog = (catalog: SqlCatalog): void => {
  if (catalog.server.length === 0 || catalog.database.length === 0 || catalog.version.length === 0) throw new TypeError("SQL catalog server, database, and version must not be empty.");
  const schemaNames = catalog.schemas.map(({ name }) => name);
  if (new Set(schemaNames).size !== schemaNames.length) throw new TypeError("SQL schema names must be unique.");
  const tables = new Map<string, SqlTableCatalog>();
  for (const schema of catalog.schemas) {
    nonEmpty("SQL schema name", schema.name);
    const names = schema.tables.map(({ name }) => name);
    if (new Set(names).size !== names.length) throw new TypeError(`SQL table names in schema ${schema.name} must be unique.`);
    for (const table of schema.tables) {
      nonEmpty("SQL table name", table.name);
      const key = tableKey({ schema: schema.name, name: table.name });
      tables.set(key, table);
      const columns = table.columns.map(({ name }) => name);
      if (new Set(columns).size !== columns.length) throw new TypeError(`SQL column names in ${key} must be unique.`);
      if (columns.some((name) => reservedRowAttributes.has(name))) throw new TypeError(`SQL table ${key} uses a reserved row attribute.`);
      for (const column of table.columns) {
        nonEmpty("SQL column name", column.name);
        if (!columnTypes.has(column.scalar)) throw new TypeError(`SQL column ${key}.${column.name} has an unsupported scalar type.`);
      }
      for (const name of [...(table.primaryKey ?? []), ...(table.revisionColumn === undefined ? [] : [table.revisionColumn])]) {
        if (!columns.includes(name)) throw new TypeError(`SQL table ${key} refers to unknown column ${name}.`);
      }
      if ((table.primaryKey?.length ?? 0) === 0 && table.primaryKey !== undefined) throw new TypeError(`SQL table ${key} primary key must not be empty.`);
      natural("Estimated SQL row count", table.estimatedRows);
    }
  }
  const relationNames = (catalog.relations ?? []).map(({ name }) => name);
  if (new Set(relationNames).size !== relationNames.length) throw new TypeError("SQL relation names must be unique.");
  for (const relation of catalog.relations ?? []) {
    nonEmpty("SQL relation name", relation.name);
    for (const endpoint of [relation.from, relation.to]) {
      const table = tables.get(tableKey(endpointTable(endpoint)));
      if (table === undefined) throw new TypeError(`SQL relation ${relation.name} refers to an unknown table.`);
      if (endpoint.columns.length === 0 || endpoint.columns.some((column) => !table.columns.some(({ name }) => name === column))) throw new TypeError(`SQL relation ${relation.name} refers to an unknown column.`);
    }
  }
};

const combinedRowAttributes = (catalog: SqlCatalog): Readonly<Record<string, AttributeSchema>> => {
  const values = new Map<string, Set<SqlColumnType>>();
  for (const column of catalog.schemas.flatMap(({ tables }) => tables.flatMap(({ columns }) => columns))) {
    const types = values.get(column.name) ?? new Set<SqlColumnType>();
    types.add(column.scalar);
    if (column.nullable) types.add("null");
    values.set(column.name, types);
  }
  return Object.fromEntries([
    ["_table", { scalar: "string", cardinality: "one", required: true }],
    ["_identity", { scalar: "string", cardinality: "one", required: true }],
    ["_revision", { scalar: ["string", "number", "boolean", "null"], cardinality: "one", required: false }],
    ...[...values].map(([name, types]) => [name, {
      scalar: types.size === 1 ? [...types][0] ?? "null" : [...types],
      cardinality: "one" as const,
      required: false,
    }] as const),
  ]);
};

const catalogKind = (
  kind: NamespacedName,
  attributes: Readonly<Record<string, AttributeSchema>>,
): NodeKindSchema => ({
  kind,
  attributes,
  identity: {
    stability: kind === "sql::row" ? "observation" : "revision",
    description: kind === "sql::row"
      ? "Primary-key identity where declared; otherwise query-scoped ordinal identity."
      : "Catalog identity within its observed catalog revision.",
  },
});

const createSchema = (catalog: SqlCatalog) => defineAdapterSchema({
  namespace: "sql",
  version: `1:${catalog.version}`,
  dynamic: true,
  kinds: [
    catalogKind("sql::server", { name: { scalar: "string", cardinality: "one", required: true } }),
    catalogKind("sql::database", { name: { scalar: "string", cardinality: "one", required: true } }),
    catalogKind("sql::schema", { name: { scalar: "string", cardinality: "one", required: true } }),
    catalogKind("sql::table", {
      name: { scalar: "string", cardinality: "one", required: true },
      schema: { scalar: "string", cardinality: "one", required: true },
      estimatedRows: { scalar: "number", cardinality: "one", required: false },
    }),
    catalogKind("sql::column", {
      name: { scalar: "string", cardinality: "one", required: true },
      schema: { scalar: "string", cardinality: "one", required: true },
      table: { scalar: "string", cardinality: "one", required: true },
      scalar: { scalar: "string", cardinality: "one", required: true },
      nullable: { scalar: "boolean", cardinality: "one", required: true },
    }),
    catalogKind("sql::relation", { name: { scalar: "string", cardinality: "one", required: true } }),
    catalogKind("sql::row", combinedRowAttributes(catalog)),
    catalogKind("sql::aggregate", {
      function: { scalar: "string", cardinality: "one", required: true },
      column: { scalar: ["string", "null"], cardinality: "one", required: true },
      value: { scalar: ["string", "number", "boolean", "null"], cardinality: "one", required: true },
    }),
  ],
  edges: [
    { name: "sql::children", role: "child" as const, from: ["sql::server", "sql::database", "sql::schema", "sql::table"], to: ["sql::database", "sql::schema", "sql::table", "sql::column", "sql::relation"], ordering: "stable" as const },
    { name: "sql::from", role: "reference" as const, from: ["sql::relation"], to: ["sql::table"], ordering: "stable" as const },
    { name: "sql::to", role: "reference" as const, from: ["sql::relation"], to: ["sql::table"], ordering: "stable" as const },
  ],
  operations: [
    { kind: "sql::update-rows", arguments: {} },
    { kind: "sql::delete-rows", arguments: {} },
  ],
  treeViews: [{ name: "sql::catalog", rootKinds: ["sql::server"], childEdges: ["sql::children"], default: true }],
  capabilities: {
    traversal: ["tree", "reference"],
    pushdown: ["predicate", "projection", "sort", "aggregation", "join", "offset", "limit"],
    ordering: "unknown",
    revisions: true,
    transactions: "local",
    semanticOperations: true,
    rollback: true,
    compensation: false,
    parallelReads: true,
    parallelWrites: false,
  },
});

interface ResolvedTable {
  readonly reference: SqlTableReference;
  readonly table: SqlTableCatalog;
  readonly alias: string;
}

const tableMap = (catalog: SqlCatalog): ReadonlyMap<string, SqlTableCatalog> => new Map(
  catalog.schemas.flatMap((schema) => schema.tables.map((table) => [tableKey({ schema: schema.name, name: table.name }), table] as const)),
);

const resolveTable = (catalog: SqlCatalog, reference: SqlTableReference): SqlTableCatalog => {
  const table = tableMap(catalog).get(tableKey(reference));
  if (table === undefined) throw new TypeError(`Unknown SQL table ${tableKey(reference)}.`);
  return table;
};

const resolveColumn = (
  tables: readonly ResolvedTable[],
  selection: SqlColumnSelection,
): { readonly table: ResolvedTable; readonly column: SqlColumnCatalog } => {
  const candidates = typeof selection === "string"
    ? tables.flatMap((table) => table.table.columns.filter(({ name }) => name === selection).map((column) => ({ table, column })))
    : tables.filter(({ alias, reference }) => alias === selection.table || reference.name === selection.table)
      .flatMap((table) => table.table.columns.filter(({ name }) => name === selection.column).map((column) => ({ table, column })));
  if (candidates.length === 0) throw new TypeError(`Unknown SQL column ${JSON.stringify(typeof selection === "string" ? selection : `${selection.table}.${selection.column}`)}.`);
  if (candidates.length > 1) throw new TypeError(`Ambiguous SQL column ${JSON.stringify(typeof selection === "string" ? selection : `${selection.table}.${selection.column}`)}.`);
  return candidates[0] as { readonly table: ResolvedTable; readonly column: SqlColumnCatalog };
};

const compilePredicate = (
  predicate: SqlPredicate,
  tables: readonly ResolvedTable[],
  parameters: SqlValue[],
): string => {
  const column = (selection: SqlColumnSelection): string => {
    const resolved = resolveColumn(tables, selection);
    return `${quote(resolved.table.alias)}.${quote(resolved.column.name)}`;
  };
  const parameter = (value: SqlValue): string => { assertSqlValue(value); parameters.push(value); return `$${parameters.length}`; };
  if (predicate.kind === "comparison") {
    if (!comparisonOperators.has(predicate.operator)) throw new TypeError(`Unsupported SQL comparison operator ${JSON.stringify(predicate.operator)}.`);
    return `${column(predicate.column)} ${predicate.operator.toUpperCase()} ${parameter(predicate.value)}`;
  }
  if (predicate.kind === "in") return predicate.values.length === 0
    ? "FALSE"
    : `${column(predicate.column)} IN (${predicate.values.map(parameter).join(", ")})`;
  if (predicate.kind === "is-null") return `${column(predicate.column)} IS ${predicate.not === true ? "NOT " : ""}NULL`;
  if (predicate.kind === "not") return `NOT (${compilePredicate(predicate.predicate, tables, parameters)})`;
  if (predicate.predicates.length === 0) throw new TypeError(`SQL ${predicate.kind.toUpperCase()} predicate must not be empty.`);
  return `(${predicate.predicates.map((value) => compilePredicate(value, tables, parameters)).join(` ${predicate.kind.toUpperCase()} `)})`;
};

const compileQuery = (catalog: SqlCatalog, source: SqlRowSource): SqlCompiledQuery => {
  natural("SQL limit", source.limit);
  natural("SQL offset", source.offset);
  if (source.runtimePredicate !== undefined && source.aggregate !== undefined) throw new TypeError("Runtime SQL predicate fallback cannot follow native aggregation.");
  if (source.runtimePredicate !== undefined && source.offset !== undefined) throw new TypeError("Runtime SQL predicate fallback with offset is unsupported because ordering semantics would be ambiguous.");
  const baseTable = resolveTable(catalog, source.table);
  const base: ResolvedTable = { reference: source.table, table: baseTable, alias: source.table.name };
  const tables: ResolvedTable[] = [base];
  for (const join of source.joins ?? []) {
    if (join.kind !== "inner") throw new TypeError(`Unsupported SQL join kind ${JSON.stringify(join.kind)}.`);
    const table = resolveTable(catalog, join.table);
    if (tables.some(({ alias }) => alias === join.table.name)) throw new TypeError(`Duplicate SQL table alias ${join.table.name}.`);
    tables.push({ reference: join.table, table, alias: join.table.name });
  }
  const parameters: SqlValue[] = [];
  const joins = (source.joins ?? []).map((join, index) => {
    const right = tables[index + 1] as ResolvedTable;
    const leftColumn = base.table.columns.find(({ name }) => name === join.on.left);
    const rightColumn = right.table.columns.find(({ name }) => name === join.on.right);
    if (leftColumn === undefined || rightColumn === undefined) throw new TypeError("SQL join refers to an unknown column.");
    return `INNER JOIN ${qualifiedTable(right.reference)} AS ${quote(right.alias)} ON ${quote(base.alias)}.${quote(leftColumn.name)} = ${quote(right.alias)}.${quote(rightColumn.name)}`;
  });
  const selected = source.select ?? baseTable.columns.map(({ name }) => name);
  const resolvedSelected = selected.map((selection) => resolveColumn(tables, selection));
  const outputColumns = resolvedSelected.map(({ column }) => column.name);
  if (new Set(outputColumns).size !== outputColumns.length) throw new TypeError("SQL projected column names must be unique across joined tables.");
  const hidden = [...(baseTable.primaryKey ?? []), ...(baseTable.revisionColumn === undefined ? [] : [baseTable.revisionColumn])]
    .filter((name) => !outputColumns.includes(name))
    .map((name) => resolveColumn([base], name));
  let projection: string;
  if (source.aggregate === undefined) {
    projection = [...resolvedSelected, ...hidden]
      .map(({ table, column }) => `${quote(table.alias)}.${quote(column.name)} AS ${quote(column.name)}`)
      .join(", ");
  } else {
    nonEmpty("SQL aggregate alias", source.aggregate.as);
    const aggregateColumn = source.aggregate.column === undefined
      ? "*"
      : (() => { const value = resolveColumn(tables, source.aggregate?.column as SqlColumnSelection); return `${quote(value.table.alias)}.${quote(value.column.name)}`; })();
    if (source.aggregate.function !== "count" && source.aggregate.column === undefined) throw new TypeError(`SQL ${source.aggregate.function} aggregation requires a column.`);
    projection = `${source.aggregate.function.toUpperCase()}(${aggregateColumn}) AS ${quote(source.aggregate.as)}`;
  }
  const clauses = [`SELECT ${projection}`, `FROM ${qualifiedTable(source.table)} AS ${quote(base.alias)}`, ...joins];
  if (source.where !== undefined) clauses.push(`WHERE ${compilePredicate(source.where, tables, parameters)}`);
  if ((source.orderBy?.length ?? 0) > 0) clauses.push(`ORDER BY ${source.orderBy?.map(({ column, direction }) => {
    if (direction !== "asc" && direction !== "desc") throw new TypeError(`Unsupported SQL order direction ${JSON.stringify(direction)}.`);
    const value = resolveColumn(tables, column);
    return `${quote(value.table.alias)}.${quote(value.column.name)} ${direction.toUpperCase()}`;
  }).join(", ")}`);
  if (source.limit !== undefined && source.runtimePredicate === undefined) { parameters.push(source.limit); clauses.push(`LIMIT $${parameters.length}`); }
  if (source.offset !== undefined) { parameters.push(source.offset); clauses.push(`OFFSET $${parameters.length}`); }
  const pushed = [
    source.where === undefined ? undefined : "predicate",
    source.select === undefined ? undefined : "projection",
    source.orderBy === undefined ? undefined : "sort",
    source.aggregate === undefined ? undefined : "aggregation",
    (source.joins?.length ?? 0) === 0 ? undefined : "join",
    source.offset === undefined ? undefined : "offset",
    source.limit === undefined || source.runtimePredicate !== undefined ? undefined : "limit",
  ].filter((value): value is string => value !== undefined);
  const fallback = [
    source.runtimePredicate === undefined ? undefined : "predicate",
    source.runtimePredicate === undefined || source.limit === undefined ? undefined : "limit",
  ].filter((value): value is string => value !== undefined);
  return Object.freeze({
    request: Object.freeze({ text: clauses.join(" "), parameters: Object.freeze(parameters) }),
    table: baseTable,
    tableReference: source.table,
    outputColumns: Object.freeze(outputColumns),
    identityColumns: Object.freeze([...(baseTable.primaryKey ?? [])]),
    ...(baseTable.revisionColumn === undefined ? {} : { revisionColumn: baseTable.revisionColumn }),
    ...(source.aggregate === undefined ? {} : { aggregate: source.aggregate }),
    pushdown: pushed.join(","),
    fallback: fallback.join(","),
    ordering: source.orderBy === undefined ? "unknown" : "stable",
  });
};

const rowHandle = (snapshot: NodeSnapshot): NavigableNodeHandle => Object.freeze({
  snapshot,
  edges: () => ({ async *[Symbol.asyncIterator]() {} }),
  resolve: async () => undefined,
});

const rowAttributes = (row: SqlRow, compiled: SqlCompiledQuery): Readonly<Record<string, AttributeValue>> => {
  const values: Record<string, AttributeValue> = {
    _table: tableKey(compiled.tableReference),
    _identity: compiled.identityColumns.length === 0 ? "query-ordinal" : "primary-key",
  };
  for (const name of compiled.outputColumns) {
    const value = row[name];
    if (value !== undefined) values[name] = value;
  }
  if (compiled.revisionColumn !== undefined && row[compiled.revisionColumn] !== undefined) values["_revision"] = row[compiled.revisionColumn] as SqlValue;
  return Object.freeze(values);
};

const compileMutationPredicate = (
  catalog: SqlCatalog,
  target: SqlMutationTarget,
  parameters: SqlValue[],
): { readonly table: SqlTableCatalog; readonly sql: string } => {
  const table = resolveTable(catalog, target.table);
  const resolved: ResolvedTable = { reference: target.table, table, alias: target.table.name };
  let sql = compilePredicate(target.where, [resolved], parameters);
  if (target.concurrency.kind === "optimistic") {
    if (table.revisionColumn !== target.concurrency.column) throw new TypeError(`SQL optimistic concurrency must use revision column ${JSON.stringify(table.revisionColumn)}.`);
    natural("Expected affected SQL rows", target.concurrency.expectedRows);
    if (target.concurrency.expectedRows === 0) throw new TypeError("Optimistic SQL mutation must expect at least one row.");
    assertSqlValue(target.concurrency.expected);
    parameters.push(target.concurrency.expected);
    sql = `(${sql}) AND ${quote(resolved.alias)}.${quote(target.concurrency.column)} = $${parameters.length}`;
  }
  return { table, sql };
};

const compileMutation = (catalog: SqlCatalog, operation: SqlOperation): SqlChangePayload => {
  const parameters: SqlValue[] = [];
  let request: SqlQueryRequest;
  const target = operation.payload.target;
  if (operation.kind === "sql::update-rows") {
    const entries = Object.entries(operation.payload.values).toSorted(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) throw new TypeError("SQL update requires at least one value.");
    const table = resolveTable(catalog, target.table);
    for (const [name, value] of entries) {
      if (!table.columns.some((column) => column.name === name)) throw new TypeError(`Unknown SQL update column ${JSON.stringify(name)}.`);
      assertSqlValue(value);
      parameters.push(value);
    }
    const assignments = entries.map(([name], index) => `${quote(name)} = $${index + 1}`).join(", ");
    const predicate = compileMutationPredicate(catalog, target, parameters);
    request = { text: `UPDATE ${qualifiedTable(target.table)} AS ${quote(target.table.name)} SET ${assignments} WHERE ${predicate.sql}`, parameters };
  } else {
    const predicate = compileMutationPredicate(catalog, target, parameters);
    request = { text: `DELETE FROM ${qualifiedTable(target.table)} AS ${quote(target.table.name)} WHERE ${predicate.sql}`, parameters };
  }
  return immutableCopy({
    request,
    concurrency: target.concurrency.kind,
    ...(target.concurrency.kind === "optimistic" ? { expectedAffectedRows: target.concurrency.expectedRows } : {}),
  });
};

export const sqlUpdateRows = (
  adapter: SqlAdapter,
  target: SqlMutationTarget,
  values: Readonly<Record<string, SqlValue>>,
): SqlUpdateRowsOperation => {
  adapter.compile({ table: target.table, where: target.where, limit: 0 });
  return immutableCopy({
    kind: "sql::update-rows",
    resource: target.resource,
    payload: { target, values },
  });
};

export const sqlDeleteRows = (
  adapter: SqlAdapter,
  target: SqlMutationTarget,
): SqlDeleteRowsOperation => {
  adapter.compile({ table: target.table, where: target.where, limit: 0 });
  return immutableCopy({ kind: "sql::delete-rows", resource: target.resource, payload: { target } });
};

export const createSqlAdapter = (options: SqlAdapterOptions): SqlAdapter => {
  validateCatalog(options.catalog);
  if (options.uri.length === 0) throw new TypeError("SQL adapter URI must not be empty.");
  const catalog = immutableCopy(options.catalog);
  const schema = createSchema(catalog);
  const resource = defineResource({ id: catalog.database, adapter: "sql", uri: options.uri, revision: catalog.version });
  const id = (local: string): NodeId => ({ adapter: "sql", resource: resource.id, local });
  const nodes: NodeSnapshot[] = [];
  const edges: Edge[] = [];
  const addNode = (local: string, kind: NamespacedName, attributes: Readonly<Record<string, AttributeValue>>): NodeSnapshot => {
    const node = defineNodeSnapshot({ id: id(local), kind, attributes, origin: { uri: options.uri, revision: catalog.version } });
    nodes.push(node);
    return node;
  };
  const addEdge = (name: "sql::children" | "sql::from" | "sql::to", role: "child" | "reference", from: NodeSnapshot, to: NodeSnapshot, ordinal?: number): void => {
    edges.push(defineEdge({ name, role, from: from.id, to: to.id, ...(ordinal === undefined ? {} : { ordinal }) }));
  };
  const server = addNode("server", "sql::server", { name: catalog.server });
  const database = addNode("database", "sql::database", { name: catalog.database });
  addEdge("sql::children", "child", server, database, 0);
  const tablesByKey = new Map<string, NodeSnapshot>();
  for (const [schemaIndex, schemaCatalog] of catalog.schemas.entries()) {
    const schemaNode = addNode(`schema:${schemaCatalog.name}`, "sql::schema", { name: schemaCatalog.name });
    addEdge("sql::children", "child", database, schemaNode, schemaIndex);
    for (const [tableIndex, table] of schemaCatalog.tables.entries()) {
      const tableNode = addNode(`table:${schemaCatalog.name}.${table.name}`, "sql::table", {
        name: table.name,
        schema: schemaCatalog.name,
        ...(table.estimatedRows === undefined ? {} : { estimatedRows: table.estimatedRows }),
      });
      tablesByKey.set(tableKey({ schema: schemaCatalog.name, name: table.name }), tableNode);
      addEdge("sql::children", "child", schemaNode, tableNode, tableIndex);
      for (const [columnIndex, column] of table.columns.entries()) {
        const columnNode = addNode(`column:${schemaCatalog.name}.${table.name}.${column.name}`, "sql::column", {
          name: column.name, schema: schemaCatalog.name, table: table.name, scalar: column.scalar, nullable: column.nullable,
        });
        addEdge("sql::children", "child", tableNode, columnNode, columnIndex);
      }
    }
  }
  for (const [index, relation] of (catalog.relations ?? []).entries()) {
    const relationNode = addNode(`relation:${relation.name}`, "sql::relation", { name: relation.name });
    addEdge("sql::children", "child", database, relationNode, catalog.schemas.length + index);
    const from = tablesByKey.get(tableKey(endpointTable(relation.from)));
    const to = tablesByKey.get(tableKey(endpointTable(relation.to)));
    if (from !== undefined) addEdge("sql::from", "reference", relationNode, from, 0);
    if (to !== undefined) addEdge("sql::to", "reference", relationNode, to, 0);
  }
  const nodesByLocal = new Map(nodes.map((node) => [node.id.local, node]));
  const stats = { metadataOpened: 0, metadataClosed: 0, queries: 0, rowsRead: 0, transactions: 0, statements: 0 };
  const read: ReadCapability = {
    async open(source, context) {
      context.signal?.throwIfAborted();
      if (source.uri !== options.uri) throw new TypeError(`Unknown SQL catalog URI ${source.uri}.`);
      stats.metadataOpened += 1;
      let closed = false;
      return {
        resource,
        async close() { if (!closed) { closed = true; stats.metadataClosed += 1; } },
      };
    },
    roots(_resource: Resource, request) {
      return { async *[Symbol.asyncIterator]() { request.signal?.throwIfAborted(); yield server; } };
    },
    edges(node, request) {
      return {
        async *[Symbol.asyncIterator]() {
          for (const edge of edges) {
            request.signal?.throwIfAborted();
            if (matchesEdge(edge, node, request)) yield edge;
          }
        },
      };
    },
    async hydrate(ids, projection) {
      projection.signal?.throwIfAborted();
      return ids.flatMap((node) => nodesByLocal.get(node.local) ?? []);
    },
  };
  const planning = {
    async plan(operation: SqlOperation, context: PlanContext): Promise<readonly SqlChange[]> {
      context.signal?.throwIfAborted();
      if (operation.resource !== resource.id) throw new TypeError(`Unknown SQL resource ${operation.resource}.`);
      const payload = compileMutation(catalog, operation);
      return [immutableCopy({
        adapter: "sql",
        resource: resource.id,
        resourceUri: resource.uri,
        resourceRevision: resource.revision,
        kind: operation.kind,
        risk: "irreversible",
        summary: `${operation.kind === "sql::update-rows" ? "Update" : "Delete"} rows in ${tableKey(operation.payload.target.table)}.`,
        reversible: false,
        payload,
        preconditions: [{ resource: resource.id, uri: resource.uri, expectedRevision: resource.revision, expectation: "exists", description: "SQL catalog revision and mutation concurrency predicate must still match." }],
        regions: [{ uri: `${resource.uri}#${tableKey(operation.payload.target.table)}` }],
        transaction: { key: resource.id, atomic: true, rollback: "adapter", compensation: "none" },
      })];
    },
  };
  const apply = {
    async apply(changes: readonly SqlChange[], context: ApplyContext): Promise<ApplyResult> {
      context.signal?.throwIfAborted();
      const currentVersion = await options.client.catalogVersion(context.signal === undefined ? {} : { signal: context.signal });
      if (currentVersion !== catalog.version) throw new TypeError(`SQL catalog revision ${currentVersion} does not match planned revision ${catalog.version}.`);
      const statements = changes.map(({ payload }) => payload.request);
      stats.transactions += 1;
      stats.statements += statements.length;
      const results = await options.client.transaction(statements, context.signal === undefined ? {} : { signal: context.signal });
      if (results.length !== changes.length) throw new TypeError("SQL client returned an invalid transaction result count.");
      for (const [index, change] of changes.entries()) {
        const expected = change.payload.expectedAffectedRows;
        const result = results[index];
        if (result === undefined || !Number.isSafeInteger(result.affectedRows) || result.affectedRows < 0) throw new TypeError("SQL client returned an invalid affected-row count.");
        if (expected !== undefined && result.affectedRows !== expected) throw new TypeError(`SQL optimistic concurrency expected ${expected} affected rows but observed ${result.affectedRows}.`);
      }
      return Object.freeze({ applied: changes.length, diagnostics: Object.freeze([]) });
    },
  };
  const adapter: SqlAdapter = {
    contractVersion: "1",
    namespace: "sql",
    schema,
    read,
    planning,
    apply,
    compile(source) { return compileQuery(catalog, source); },
    scan(_source, compiled, signal) {
      return {
        async *[Symbol.asyncIterator]() {
          stats.queries += 1;
          let ordinal = 0;
          const queryIdentity = digest(`${compiled.request.text}\0${JSON.stringify(compiled.request.parameters)}`);
          for await (const row of options.client.query(compiled.request, signal === undefined ? {} : { signal })) {
            signal?.throwIfAborted();
            stats.rowsRead += 1;
            if (compiled.aggregate !== undefined) {
              const value = row[compiled.aggregate.as];
              if (value === undefined) throw new TypeError(`SQL aggregate result omitted ${compiled.aggregate.as}.`);
              yield rowHandle(defineNodeSnapshot({
                id: { adapter: "sql", resource: resource.id, local: `aggregate:${queryIdentity}:${ordinal}` },
                kind: "sql::aggregate",
                attributes: { function: compiled.aggregate.function, column: typeof compiled.aggregate.column === "string" ? compiled.aggregate.column : compiled.aggregate.column?.column ?? null, value },
                origin: { uri: `${resource.uri}#${tableKey(compiled.tableReference)}`, revision: resource.revision },
              }));
            } else {
              const identityValues = compiled.identityColumns.map((name) => {
                const value = row[name];
                if (value === undefined) throw new TypeError(`SQL row omitted identity column ${name}.`);
                return value;
              });
              const local = identityValues.length === 0
                ? `row:${queryIdentity}:${ordinal}`
                : `row:${tableKey(compiled.tableReference)}:${JSON.stringify(identityValues)}`;
              const revision = compiled.revisionColumn === undefined ? undefined : row[compiled.revisionColumn];
              yield rowHandle(defineNodeSnapshot({
                id: { adapter: "sql", resource: resource.id, local },
                kind: "sql::row",
                attributes: rowAttributes(row, compiled),
                origin: {
                  uri: `${resource.uri}#${tableKey(compiled.tableReference)}`,
                  ...(revision === undefined ? {} : { revision: String(revision) }),
                },
              }));
            }
            ordinal += 1;
          }
        },
      };
    },
    statistics: () => Object.freeze({ ...stats }),
  };
  return Object.freeze(adapter);
};

export const fromSqlRows = (
  adapter: SqlAdapter,
  source: SqlRowSource,
): Query<NavigableNodeHandle> => {
  const compiled = adapter.compile(source);
  let query = fromValues(
    (options) => adapter.scan(source, compiled, options.signal),
    {
      ordering: compiled.ordering,
      label: "sql",
      details: {
        table: tableKey(source.table),
        sql: compiled.request.text,
        pushdown: compiled.pushdown,
        fallback: compiled.fallback,
      },
    },
  );
  if (source.runtimePredicate !== undefined) {
    query = query.filter((value) => source.runtimePredicate?.(value.snapshot.attributes as SqlRow) ?? true, "sql runtime predicate");
    if (source.limit !== undefined) query = query.take(source.limit);
  }
  return query;
};
