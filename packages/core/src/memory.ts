import type {
  Adapter,
  AttributeProjection,
  OpenContext,
  ReadCapability,
  ResourceHandle,
  RootRequest,
  SourceDescriptor,
} from "./adapter.js";
import { defineEdge, defineNodeSnapshot, defineResource } from "./model.js";
import type {
  AttributeValue,
  Edge,
  EdgeRequest,
  NodeId,
  NodeSnapshot,
  Resource,
  SelectionOrdering,
} from "./model.js";
import { defineAdapterSchema } from "./schema.js";
import type { AttributeSchema, ScalarType } from "./schema.js";

export interface InMemoryFixture {
  readonly resource: Resource;
  readonly nodes: readonly NodeSnapshot[];
  readonly edges: readonly Edge[];
  readonly roots: readonly (string | NodeId)[];
  readonly ordering?: SelectionOrdering;
}

export interface InMemoryStatistics {
  readonly opened: number;
  readonly closed: number;
  readonly rootsRead: number;
  readonly edgesRead: number;
  readonly hydrated: number;
}

export interface InMemoryAdapter extends Adapter {
  readonly read: ReadCapability;
  statistics(): InMemoryStatistics;
}

const idKey = (id: NodeId): string =>
  `${id.adapter.length}:${id.adapter}${id.resource.length}:${id.resource}${id.local.length}:${id.local}`;

const abort = (signal: AbortSignal | undefined): void => {
  signal?.throwIfAborted();
};

const scalarTypeOf = (value: Exclude<AttributeValue, readonly unknown[]>): ScalarType => {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "bigint";
};

const inferAttributes = (
  nodes: readonly NodeSnapshot[],
): Readonly<Record<string, AttributeSchema>> => {
  const names = [...new Set(nodes.flatMap(({ attributes }) => Object.keys(attributes)))];
  return Object.fromEntries(
    names.map((name) => {
      const present = nodes.filter(({ attributes }) => Object.hasOwn(attributes, name));
      const values = present.flatMap(({ attributes }) => {
        const value = attributes[name];
        return value === undefined ? [] : Array.isArray(value) ? value : [value];
      });
      const types = [...new Set(values.map(scalarTypeOf))];
      const scalar: ScalarType | readonly ScalarType[] =
        types.length === 1 ? (types[0] ?? "null") : types;
      return [
        name,
        {
          scalar,
          cardinality: present.some(({ attributes }) => Array.isArray(attributes[name]))
            ? "many"
            : "one",
          required: present.length === nodes.length,
        },
      ];
    }),
  );
};

const inferSchema = (
  resource: Resource,
  nodes: readonly NodeSnapshot[],
  edges: readonly Edge[],
  ordering: SelectionOrdering,
) => {
  const kinds = [...new Set(nodes.map((node) => node.kind))];
  const nodesById = new Map(nodes.map((node) => [idKey(node.id), node]));
  const edgeNames = [...new Set(edges.map((edge) => edge.name))];
  return defineAdapterSchema({
    namespace: resource.adapter,
    version: "1.0.0",
    dynamic: true,
    kinds: kinds.map((kind) => {
      const matching = nodes.filter((node) => node.kind === kind);
      return {
        kind,
        attributes: inferAttributes(matching),
        identity: { stability: "revision", description: "in-memory fixture node id" },
      };
    }),
    edges: edgeNames.map((name) => {
      const matching = edges.filter((edge) => edge.name === name);
      return {
        name,
        role: matching[0]?.role ?? "reference",
        from: [
          ...new Set(
            matching.flatMap((edge) => {
              const node = nodesById.get(idKey(edge.from));
              return node === undefined ? [] : [node.kind];
            }),
          ),
        ],
        to: [
          ...new Set(
            matching.flatMap((edge) => {
              const node = nodesById.get(idKey(edge.to));
              return node === undefined ? [] : [node.kind];
            }),
          ),
        ],
        ordering,
      };
    }),
    operations: [],
    treeViews: [
      {
        name: `${resource.adapter}::default`,
        rootKinds: kinds,
        childEdges: edgeNames.filter((name) =>
          edges.some((edge) => edge.name === name && edge.role === "child"),
        ),
        default: true,
      },
    ],
    capabilities: {
      traversal: ["tree", "reference"],
      pushdown: [],
      ordering,
      revisions: resource.revision !== undefined,
      transactions: "none",
    },
  });
};

export const createInMemoryAdapter = (fixture: InMemoryFixture): InMemoryAdapter => {
  const resource = defineResource(fixture.resource);
  const nodes = fixture.nodes.map(defineNodeSnapshot);
  const edges = fixture.edges.map(defineEdge);
  const ordering = fixture.ordering ?? "stable";
  const nodesById = new Map(nodes.map((node) => [idKey(node.id), node]));
  const roots = fixture.roots.map((root) =>
    typeof root === "string"
      ? { adapter: resource.adapter, resource: resource.id, local: root }
      : root,
  );
  const state = { opened: 0, closed: 0, rootsRead: 0, edgesRead: 0, hydrated: 0 };

  for (const node of nodes) {
    if (node.id.adapter !== resource.adapter || node.id.resource !== resource.id) {
      throw new TypeError(`Node ${node.id.local} does not belong to resource ${resource.id}.`);
    }
  }
  for (const root of roots) {
    if (!nodesById.has(idKey(root))) {
      throw new TypeError(`Unknown in-memory root ${root.local}.`);
    }
  }
  for (const edge of edges) {
    if (!nodesById.has(idKey(edge.from)) || !nodesById.has(idKey(edge.to))) {
      throw new TypeError(`Edge ${edge.name} refers to an unknown in-memory node.`);
    }
    if (edges.some((candidate) => candidate.name === edge.name && candidate.role !== edge.role)) {
      throw new TypeError(`Edge ${edge.name} cannot have multiple roles.`);
    }
  }

  const read: ReadCapability = {
    async open(source: SourceDescriptor, context: OpenContext): Promise<ResourceHandle> {
      abort(context.signal);
      if (source.uri !== resource.uri) {
        throw new TypeError(`Unknown in-memory source ${JSON.stringify(source.uri)}.`);
      }
      state.opened += 1;
      let closed = false;
      return Object.freeze({
        resource,
        async close() {
          if (!closed) {
            closed = true;
            state.closed += 1;
          }
        },
      });
    },

    roots(requestedResource: Resource, request: RootRequest): AsyncIterable<NodeSnapshot> {
      return {
        async *[Symbol.asyncIterator]() {
          if (requestedResource.id !== resource.id) {
            throw new TypeError(`Unknown in-memory resource ${requestedResource.id}.`);
          }
          for (const root of roots) {
            abort(request.signal);
            state.rootsRead += 1;
            const node = nodesById.get(idKey(root));
            if (node !== undefined) yield node;
          }
        },
      };
    },

    edges(node: NodeId, request: EdgeRequest): AsyncIterable<Edge> {
      return {
        async *[Symbol.asyncIterator]() {
          const direction = request.direction ?? "forward";
          const selected = edges
            .filter((edge) =>
              direction === "forward"
                ? idKey(edge.from) === idKey(node)
                : idKey(edge.to) === idKey(node),
            )
            .filter((edge) => request.names === undefined || request.names.includes(edge.name))
            .filter((edge) => request.roles === undefined || request.roles.includes(edge.role))
            .toSorted((left, right) => (left.ordinal ?? 0) - (right.ordinal ?? 0));
          for (const edge of selected) {
            abort(request.signal);
            state.edgesRead += 1;
            yield edge;
          }
        },
      };
    },

    async hydrate(
      ids: readonly NodeId[],
      projection: AttributeProjection,
    ): Promise<readonly NodeSnapshot[]> {
      abort(projection.signal);
      const hydrated: NodeSnapshot[] = [];
      for (const id of ids) {
        abort(projection.signal);
        const node = nodesById.get(idKey(id));
        if (node !== undefined) {
          state.hydrated += 1;
          hydrated.push(node);
        }
      }
      return hydrated;
    },
  };

  return Object.freeze({
    namespace: resource.adapter,
    schema: inferSchema(resource, nodes, edges, ordering),
    read,
    statistics: () => Object.freeze({ ...state }),
  });
};
