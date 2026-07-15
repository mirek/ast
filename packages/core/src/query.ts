import type { Adapter, SourceDescriptor } from "./adapter.js";
import type {
  EdgeName,
  EdgeRequest,
  EdgeRole,
  NodeHandle,
  NodeId,
  NodeSnapshot,
  Selection,
  SelectionOrdering,
} from "./model.js";

export type CaptureMap = Readonly<Record<string, unknown>>;
export type EmptyCaptures = Readonly<Record<never, never>>;
export type MaybePromise<T> = T | PromiseLike<T>;

export interface ExecuteOptions {
  readonly signal?: AbortSignal;
}

export interface LogicalPlan {
  readonly operator: QueryOperator;
  readonly ordering: SelectionOrdering;
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly inputs: readonly LogicalPlan[];
}

export interface PhysicalPlan {
  readonly operator: QueryOperator;
  readonly ordering: SelectionOrdering;
  readonly buffering: boolean;
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly inputs: readonly PhysicalPlan[];
}

export interface QueryExplanation {
  readonly logical: LogicalPlan;
  readonly physical: PhysicalPlan;
}

export type QueryOperator =
  | "source"
  | "filter"
  | "project"
  | "flat-map"
  | "distinct"
  | "take"
  | "count"
  | "group"
  | "sort"
  | "capture"
  | "join"
  | "traverse";

export interface Group<Key, Value> {
  readonly key: Key;
  readonly values: readonly Value[];
}

export interface JoinOptions<Left, Right, Key> {
  readonly leftKey: (value: Left) => MaybePromise<Key>;
  readonly rightKey: (value: Right) => MaybePromise<Key>;
  readonly label?: string;
}

export interface TraverseOptions {
  readonly edgeNames?: readonly EdgeName[];
  readonly roles?: readonly EdgeRole[];
  readonly direction?: EdgeRequest["direction"];
  readonly maxDepth: number;
  readonly includeSelf?: boolean;
}

export interface NavigableNodeHandle extends NodeHandle {
  resolve(id: NodeId, signal?: AbortSignal): Promise<NavigableNodeHandle | undefined>;
}

interface QueryRow<Value, Captures extends CaptureMap> {
  readonly value: Value;
  readonly captures: Captures;
}

type RowIterable<Value, Captures extends CaptureMap> = AsyncIterable<
  QueryRow<Value, Captures>
>;

interface QueryNode<Value, Captures extends CaptureMap> {
  readonly logical: LogicalPlan;
  readonly physical: PhysicalPlan;
  readonly captureNames: ReadonlySet<string>;
  execute(options: ExecuteOptions): RowIterable<Value, Captures>;
}

type ValueSource<Value> =
  | Iterable<Value>
  | AsyncIterable<Value>
  | (() => Iterable<Value> | AsyncIterable<Value>);

const EMPTY_CAPTURES: EmptyCaptures = Object.freeze({});

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  signal?.throwIfAborted();
};

const assertNaturalNumber = (label: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
};

const freezeLogicalPlan = (
  operator: QueryOperator,
  ordering: SelectionOrdering,
  details: Readonly<Record<string, string | number | boolean>>,
  inputs: readonly LogicalPlan[],
): LogicalPlan =>
  Object.freeze({
    operator,
    ordering,
    details: Object.freeze({ ...details }),
    inputs: Object.freeze([...inputs]),
  });

const freezePhysicalPlan = (
  operator: QueryOperator,
  ordering: SelectionOrdering,
  buffersInput: boolean,
  details: Readonly<Record<string, string | number | boolean>>,
  inputs: readonly PhysicalPlan[],
): PhysicalPlan => {
  const frozenInputs = Object.freeze([...inputs]);
  return Object.freeze({
    operator,
    ordering,
    buffering: buffersInput || frozenInputs.some((input) => input.buffering),
    details: Object.freeze({ ...details }),
    inputs: frozenInputs,
  });
};

const operatorNode = <Value, Captures extends CaptureMap>(
  operator: QueryOperator,
  ordering: SelectionOrdering,
  details: Readonly<Record<string, string | number | boolean>>,
  buffersInput: boolean,
  inputs: readonly QueryNode<unknown, CaptureMap>[],
  captureNames: ReadonlySet<string>,
  execute: (options: ExecuteOptions) => RowIterable<Value, Captures>,
): QueryNode<Value, Captures> =>
  Object.freeze({
    logical: freezeLogicalPlan(
      operator,
      ordering,
      details,
      inputs.map((input) => input.logical),
    ),
    physical: freezePhysicalPlan(
      operator,
      ordering,
      buffersInput,
      details,
      inputs.map((input) => input.physical),
    ),
    captureNames: new Set(captureNames),
    execute,
  });

const toAsyncIterable = <Value>(value: Iterable<Value> | AsyncIterable<Value>): AsyncIterable<Value> => {
  const asyncIterator = (value as AsyncIterable<Value>)[Symbol.asyncIterator];
  if (asyncIterator !== undefined) return value as AsyncIterable<Value>;
  return {
    async *[Symbol.asyncIterator]() {
      yield* value;
    },
  };
};

const nodeIdKey = (id: NodeId): string =>
  `${id.adapter.length}:${id.adapter}${id.resource.length}:${id.resource}${id.local.length}:${id.local}`;

const defaultDistinctKey = (value: unknown): unknown => {
  if (
    value !== null &&
    typeof value === "object" &&
    "snapshot" in value &&
    value.snapshot !== null &&
    typeof value.snapshot === "object" &&
    "id" in value.snapshot
  ) {
    return nodeIdKey((value.snapshot as NodeSnapshot).id);
  }
  return value;
};

const combineOrdering = (
  left: SelectionOrdering,
  right: SelectionOrdering,
): SelectionOrdering => (left === "stable" && right === "stable" ? "stable" : "unknown");

export class Query<Value, Captures extends CaptureMap = EmptyCaptures>
  implements Selection<Value>
{
  readonly ordering: SelectionOrdering;
  readonly #node: QueryNode<Value, Captures>;

  constructor(node: QueryNode<Value, Captures>) {
    this.#node = node;
    this.ordering = node.logical.ordering;
    Object.freeze(this);
  }

  [Symbol.asyncIterator](): AsyncIterator<Value> {
    return this.iterate()[Symbol.asyncIterator]();
  }

  iterate(options: ExecuteOptions = {}): Selection<Value> {
    const node = this.#node;
    const ordering = this.ordering;
    return Object.freeze({
      ordering,
      async *[Symbol.asyncIterator]() {
        for await (const row of node.execute(options)) {
          throwIfAborted(options.signal);
          yield row.value;
        }
      },
    });
  }

  async toArray(options: ExecuteOptions = {}): Promise<readonly Value[]> {
    const values: Value[] = [];
    for await (const value of this.iterate(options)) values.push(value);
    return values;
  }

  explain(): QueryExplanation {
    return Object.freeze({ logical: this.#node.logical, physical: this.#node.physical });
  }

  filter(
    predicate: (value: Value, captures: Captures) => MaybePromise<boolean>,
    label = "predicate",
  ): Query<Value, Captures> {
    const parent = this.#node;
    return new Query(
      operatorNode(
        "filter",
        this.ordering,
        { label },
        false,
        [parent],
        parent.captureNames,
        (options) => ({
          async *[Symbol.asyncIterator]() {
            for await (const row of parent.execute(options)) {
              throwIfAborted(options.signal);
              if (await predicate(row.value, row.captures)) {
                throwIfAborted(options.signal);
                yield row;
              }
            }
          },
        }),
      ),
    );
  }

  project<Result>(
    projection: (value: Value, captures: Captures) => MaybePromise<Result>,
    label = "projection",
  ): Query<Result, Captures> {
    const parent = this.#node;
    return new Query(
      operatorNode(
        "project",
        this.ordering,
        { label },
        false,
        [parent],
        parent.captureNames,
        (options) => ({
          async *[Symbol.asyncIterator]() {
            for await (const row of parent.execute(options)) {
              throwIfAborted(options.signal);
              const value = await projection(row.value, row.captures);
              throwIfAborted(options.signal);
              yield { value, captures: row.captures };
            }
          },
        }),
      ),
    );
  }

  flatMap<Result>(
    projection: (
      value: Value,
      captures: Captures,
    ) => MaybePromise<Iterable<Result> | AsyncIterable<Result>>,
    label = "projection",
  ): Query<Result, Captures> {
    const parent = this.#node;
    return new Query(
      operatorNode(
        "flat-map",
        this.ordering,
        { label },
        false,
        [parent],
        parent.captureNames,
        (options) => ({
          async *[Symbol.asyncIterator]() {
            for await (const row of parent.execute(options)) {
              throwIfAborted(options.signal);
              const values = await projection(row.value, row.captures);
              for await (const value of toAsyncIterable(values)) {
                throwIfAborted(options.signal);
                yield { value, captures: row.captures };
              }
            }
          },
        }),
      ),
    );
  }

  distinct<Key = unknown>(
    key: (value: Value, captures: Captures) => MaybePromise<Key> = defaultDistinctKey as (
      value: Value,
      captures: Captures,
    ) => Key,
    label = "identity",
  ): Query<Value, Captures> {
    const parent = this.#node;
    return new Query(
      operatorNode(
        "distinct",
        this.ordering,
        { label },
        false,
        [parent],
        parent.captureNames,
        (options) => ({
          async *[Symbol.asyncIterator]() {
            const seen = new Set<Key>();
            for await (const row of parent.execute(options)) {
              throwIfAborted(options.signal);
              const identity = await key(row.value, row.captures);
              if (!seen.has(identity)) {
                seen.add(identity);
                yield row;
              }
            }
          },
        }),
      ),
    );
  }

  take(limit: number): Query<Value, Captures> {
    assertNaturalNumber("Take limit", limit);
    const parent = this.#node;
    return new Query(
      operatorNode(
        "take",
        this.ordering,
        { limit },
        false,
        [parent],
        parent.captureNames,
        (options) => ({
          async *[Symbol.asyncIterator]() {
            const iterator = parent.execute(options)[Symbol.asyncIterator]();
            let taken = 0;
            try {
              while (taken < limit) {
                throwIfAborted(options.signal);
                // Pulling concurrently would violate backpressure and could over-read the source.
                // oxlint-disable-next-line no-await-in-loop
                const next = await iterator.next();
                if (next.done) break;
                taken += 1;
                yield next.value;
              }
            } finally {
              await iterator.return?.();
            }
          },
        }),
      ),
    );
  }

  count(): Query<number, EmptyCaptures> {
    const parent = this.#node;
    return new Query(
      operatorNode(
        "count",
        "stable",
        {},
        false,
        [parent],
        new Set(),
        (options) => ({
          async *[Symbol.asyncIterator]() {
            let total = 0;
            for await (const row of parent.execute(options)) {
              void row;
              throwIfAborted(options.signal);
              total += 1;
            }
            yield { value: total, captures: EMPTY_CAPTURES };
          },
        }),
      ),
    );
  }

  groupBy<Key>(
    key: (value: Value, captures: Captures) => MaybePromise<Key>,
    label = "key",
  ): Query<Group<Key, Value>, EmptyCaptures> {
    const parent = this.#node;
    return new Query(
      operatorNode(
        "group",
        "stable",
        { label },
        true,
        [parent],
        new Set(),
        (options) => ({
          async *[Symbol.asyncIterator]() {
            const groups = new Map<Key, Value[]>();
            for await (const row of parent.execute(options)) {
              throwIfAborted(options.signal);
              const groupKey = await key(row.value, row.captures);
              const values = groups.get(groupKey);
              if (values === undefined) groups.set(groupKey, [row.value]);
              else values.push(row.value);
            }
            for (const [groupKey, values] of groups) {
              throwIfAborted(options.signal);
              yield {
                value: Object.freeze({ key: groupKey, values: Object.freeze(values) }),
                captures: EMPTY_CAPTURES,
              };
            }
          },
        }),
      ),
    );
  }

  sort(
    compare: (left: Value, right: Value) => number,
    label = "comparison",
  ): Query<Value, Captures> {
    const parent = this.#node;
    return new Query(
      operatorNode(
        "sort",
        "stable",
        { label },
        true,
        [parent],
        parent.captureNames,
        (options) => ({
          async *[Symbol.asyncIterator]() {
            const rows: QueryRow<Value, Captures>[] = [];
            for await (const row of parent.execute(options)) {
              throwIfAborted(options.signal);
              rows.push(row);
            }
            const sortedRows = rows.toSorted((left, right) => compare(left.value, right.value));
            for (const row of sortedRows) {
              throwIfAborted(options.signal);
              yield row;
            }
          },
        }),
      ),
    );
  }

  capture<const Name extends string>(
    name: Name,
  ): Query<Value, Captures & Readonly<Record<Name, Value>>> {
    if (name.length === 0) throw new TypeError("Capture name must not be empty.");
    if (this.#node.captureNames.has(name)) {
      throw new TypeError(`Capture ${JSON.stringify(name)} already exists in this scope.`);
    }
    const parent = this.#node;
    const captureNames = new Set(parent.captureNames);
    captureNames.add(name);
    return new Query(
      operatorNode(
        "capture",
        this.ordering,
        { name },
        false,
        [parent],
        captureNames,
        (options) => ({
          async *[Symbol.asyncIterator]() {
            for await (const row of parent.execute(options)) {
              throwIfAborted(options.signal);
              const captures = Object.freeze({ ...row.captures, [name]: row.value }) as Captures &
                Readonly<Record<Name, Value>>;
              yield { value: row.value, captures };
            }
          },
        }),
      ),
    );
  }

  join<Right, RightCaptures extends CaptureMap, Key>(
    right: Query<Right, RightCaptures>,
    options: JoinOptions<Value, Right, Key>,
  ): Query<readonly [Value, Right], Captures & RightCaptures> {
    const collisions = [...this.#node.captureNames].filter((name) =>
      right.#node.captureNames.has(name),
    );
    if (collisions.length > 0) {
      throw new TypeError(`Join capture scopes overlap: ${collisions.join(", ")}.`);
    }
    const leftNode = this.#node;
    const rightNode = right.#node;
    const captureNames = new Set([...leftNode.captureNames, ...rightNode.captureNames]);
    return new Query(
      operatorNode(
        "join",
        combineOrdering(this.ordering, right.ordering),
        { label: options.label ?? "equality" },
        true,
        [leftNode, rightNode],
        captureNames,
        (executeOptions) => ({
          async *[Symbol.asyncIterator]() {
            const index = new Map<Key, QueryRow<Right, RightCaptures>[]>();
            for await (const row of rightNode.execute(executeOptions)) {
              throwIfAborted(executeOptions.signal);
              const key = await options.rightKey(row.value);
              const matches = index.get(key);
              if (matches === undefined) index.set(key, [row]);
              else matches.push(row);
            }
            for await (const left of leftNode.execute(executeOptions)) {
              throwIfAborted(executeOptions.signal);
              const key = await options.leftKey(left.value);
              for (const rightRow of index.get(key) ?? []) {
                const captures = Object.freeze({
                  ...left.captures,
                  ...rightRow.captures,
                }) as Captures & RightCaptures;
                yield {
                  value: Object.freeze([left.value, rightRow.value] as const),
                  captures,
                };
              }
            }
          },
        }),
      ),
    );
  }

  traverse(
    this: Query<NavigableNodeHandle, Captures>,
    options: TraverseOptions,
  ): Query<NavigableNodeHandle, Captures> {
    assertNaturalNumber("Traversal maximum depth", options.maxDepth);
    const parent = this.#node;
    const edgeRequest: Omit<EdgeRequest, "signal"> = {
      ...(options.edgeNames === undefined ? {} : { names: options.edgeNames }),
      ...(options.roles === undefined ? {} : { roles: options.roles }),
      ...(options.direction === undefined ? {} : { direction: options.direction }),
    };
    return new Query(
      operatorNode(
        "traverse",
        this.ordering,
        {
          maxDepth: options.maxDepth,
          direction: options.direction ?? "forward",
          includeSelf: options.includeSelf ?? false,
        },
        false,
        [parent],
        parent.captureNames,
        (executeOptions) => ({
          async *[Symbol.asyncIterator]() {
            const descend = async function* (
              node: NavigableNodeHandle,
              captures: Captures,
              depth: number,
            ): AsyncIterable<QueryRow<NavigableNodeHandle, Captures>> {
              if (depth >= options.maxDepth) return;
              for await (const edge of node.edges({
                ...edgeRequest,
                ...(executeOptions.signal === undefined
                  ? {}
                  : { signal: executeOptions.signal }),
              })) {
                throwIfAborted(executeOptions.signal);
                const targetId = (options.direction ?? "forward") === "reverse" ? edge.from : edge.to;
                const target = await node.resolve(targetId, executeOptions.signal);
                if (target === undefined) continue;
                yield { value: target, captures };
                yield* descend(target, captures, depth + 1);
              }
            };

            for await (const row of parent.execute(executeOptions)) {
              throwIfAborted(executeOptions.signal);
              if (options.includeSelf === true) yield row;
              yield* descend(row.value, row.captures, 0);
            }
          },
        }),
      ),
    );
  }
}

export const fromValues = <Value>(
  values: ValueSource<Value>,
  options: { readonly ordering?: SelectionOrdering; readonly label?: string } = {},
): Query<Value> => {
  const ordering = options.ordering ?? "stable";
  return new Query(
    operatorNode(
      "source",
      ordering,
      { label: options.label ?? "values" },
      false,
      [],
      new Set(),
      (executeOptions) => ({
        async *[Symbol.asyncIterator]() {
          const source = typeof values === "function" ? values() : values;
          for await (const value of toAsyncIterable(source)) {
            throwIfAborted(executeOptions.signal);
            yield { value, captures: EMPTY_CAPTURES };
          }
        },
      }),
    ),
  );
};

const navigableHandle = (
  read: NonNullable<Adapter["read"]>,
  snapshot: NodeSnapshot,
): NavigableNodeHandle =>
  Object.freeze({
    snapshot,
    edges(request: EdgeRequest = {}) {
      return read.edges(snapshot.id, request);
    },
    async resolve(id: NodeId, signal?: AbortSignal) {
      throwIfAborted(signal);
      const [resolved] = await read.hydrate([id], {
        attributes: [],
        ...(signal === undefined ? {} : { signal }),
      });
      throwIfAborted(signal);
      return resolved === undefined ? undefined : navigableHandle(read, resolved);
    },
  });

export const fromAdapter = (
  adapter: Adapter,
  source: SourceDescriptor,
): Query<NavigableNodeHandle> => {
  if (adapter.read === undefined) {
    throw new TypeError(`Adapter ${adapter.namespace} does not provide read capability.`);
  }
  const read = adapter.read;
  const ordering = adapter.schema.capabilities.ordering;
  return new Query(
    operatorNode(
      "source",
      ordering,
      { label: adapter.namespace, uri: source.uri },
      false,
      [],
      new Set(),
      (options) => ({
        async *[Symbol.asyncIterator]() {
          throwIfAborted(options.signal);
          const requestSignal =
            options.signal === undefined ? {} : { signal: options.signal };
          const handle = await read.open(source, requestSignal);
          try {
            throwIfAborted(options.signal);
            for await (const snapshot of read.roots(handle.resource, requestSignal)) {
              throwIfAborted(options.signal);
              yield { value: navigableHandle(read, snapshot), captures: EMPTY_CAPTURES };
            }
          } finally {
            await handle.close();
          }
        },
      }),
    ),
  );
};

export const filter = <Value, Captures extends CaptureMap>(
  query: Query<Value, Captures>,
  predicate: (value: Value, captures: Captures) => MaybePromise<boolean>,
  label?: string,
): Query<Value, Captures> => query.filter(predicate, label);

export const project = <Value, Captures extends CaptureMap, Result>(
  query: Query<Value, Captures>,
  projection: (value: Value, captures: Captures) => MaybePromise<Result>,
  label?: string,
): Query<Result, Captures> => query.project(projection, label);

export const flatMap = <Value, Captures extends CaptureMap, Result>(
  query: Query<Value, Captures>,
  projection: (
    value: Value,
    captures: Captures,
  ) => MaybePromise<Iterable<Result> | AsyncIterable<Result>>,
  label?: string,
): Query<Result, Captures> => query.flatMap(projection, label);

export const distinct = <Value, Captures extends CaptureMap, Key = unknown>(
  query: Query<Value, Captures>,
  key?: (value: Value, captures: Captures) => MaybePromise<Key>,
  label?: string,
): Query<Value, Captures> => query.distinct(key, label);

export const take = <Value, Captures extends CaptureMap>(
  query: Query<Value, Captures>,
  limit: number,
): Query<Value, Captures> => query.take(limit);

export const count = <Value, Captures extends CaptureMap>(
  query: Query<Value, Captures>,
): Query<number> => query.count();

export const groupBy = <Value, Captures extends CaptureMap, Key>(
  query: Query<Value, Captures>,
  key: (value: Value, captures: Captures) => MaybePromise<Key>,
  label?: string,
): Query<Group<Key, Value>> => query.groupBy(key, label);

export const sort = <Value, Captures extends CaptureMap>(
  query: Query<Value, Captures>,
  compare: (left: Value, right: Value) => number,
  label?: string,
): Query<Value, Captures> => query.sort(compare, label);

export const capture = <Value, Captures extends CaptureMap, const Name extends string>(
  query: Query<Value, Captures>,
  name: Name,
): Query<Value, Captures & Readonly<Record<Name, Value>>> => query.capture(name);

export const join = <
  Left,
  LeftCaptures extends CaptureMap,
  Right,
  RightCaptures extends CaptureMap,
  Key,
>(
  left: Query<Left, LeftCaptures>,
  right: Query<Right, RightCaptures>,
  options: JoinOptions<Left, Right, Key>,
): Query<readonly [Left, Right], LeftCaptures & RightCaptures> => left.join(right, options);

export const traverse = <Captures extends CaptureMap>(
  query: Query<NavigableNodeHandle, Captures>,
  options: TraverseOptions,
): Query<NavigableNodeHandle, Captures> => query.traverse(options);
