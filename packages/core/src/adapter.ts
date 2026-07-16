import type { Diagnostic } from "./diagnostic.js";
import type {
  Edge,
  EdgeRequest,
  NodeId,
  NodeSnapshot,
  OperationKind,
  Resource,
  Scalar,
  NamespacedName,
} from "./model.js";
import type { AdapterSchema } from "./schema.js";

export interface SourceDescriptor {
  readonly uri: string;
  readonly treeView?: NamespacedName;
  readonly options?: Readonly<Record<string, Scalar | readonly Scalar[]>>;
}

export interface OpenContext {
  readonly signal?: AbortSignal;
}

export interface ResourceHandle {
  readonly resource: Resource;
  close(): Promise<void>;
}

export interface RootRequest {
  readonly treeView?: `${string}::${string}`;
  readonly attributes?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface AttributeProjection {
  readonly attributes: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ReadCapability {
  open(source: SourceDescriptor, context: OpenContext): Promise<ResourceHandle>;
  roots(resource: Resource, request: RootRequest): AsyncIterable<NodeSnapshot>;
  edges(node: NodeId, request: EdgeRequest): AsyncIterable<Edge>;
  hydrate(
    ids: readonly NodeId[],
    projection: AttributeProjection,
  ): Promise<readonly NodeSnapshot[]>;
}

export interface Operation<
  Kind extends OperationKind = OperationKind,
  Payload = unknown,
> {
  readonly kind: Kind;
  readonly resource: string;
  readonly target?: NodeId;
  readonly payload: Payload;
}

export interface PlanContext {
  readonly signal?: AbortSignal;
}

export interface ApplyContext {
  readonly signal?: AbortSignal;
}

export interface PlanningCapability<
  Input extends Operation = Operation,
  Planned = unknown,
> {
  plan(operation: Input, context: PlanContext): Promise<readonly Planned[]>;
}

export interface ApplyCapability<Planned = unknown, Result = unknown> {
  apply(changes: readonly Planned[], context: ApplyContext): Promise<Result>;
}

export interface MountSourceDescriptor {
  readonly uri: string;
  readonly text?: string;
  readonly revision?: string;
}

export interface MountCapability {
  readonly edge: NamespacedName;
  open(
    container: NodeSnapshot,
    source: MountSourceDescriptor,
    context: OpenContext,
  ): Promise<ResourceHandle | undefined>;
}

export interface AdapterPluginIdentity {
  readonly apiVersion: "1";
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
}

export interface Adapter {
  readonly contractVersion: "1";
  readonly namespace: string;
  readonly schema: AdapterSchema;
  readonly plugin?: AdapterPluginIdentity;
  readonly read?: ReadCapability;
  readonly planning?: PlanningCapability;
  readonly apply?: ApplyCapability;
  readonly mount?: MountCapability;
  readonly diagnostics?: () => readonly Diagnostic[];
}

export interface AdapterCompatibility {
  readonly contractVersion: "1";
  readonly namespace: string;
  readonly schemaVersion: string;
}

export const adapterCompatibility = (adapter: Adapter): AdapterCompatibility =>
  Object.freeze({
    contractVersion: adapter.contractVersion,
    namespace: adapter.namespace,
    schemaVersion: adapter.schema.version,
  });

export const validateAdapter = (adapter: Adapter): void => {
  if (adapter.contractVersion !== "1") throw new TypeError("Unsupported adapter contract version.");
  if (adapter.namespace !== adapter.schema.namespace) throw new TypeError("Adapter namespace must match its schema.");
  if (adapter.schema.capabilities.traversal.length > 0 && adapter.read === undefined) {
    throw new TypeError(`Adapter ${adapter.namespace} declares traversal without read capability.`);
  }
  if (adapter.schema.capabilities.semanticOperations === true && adapter.planning === undefined) {
    throw new TypeError(`Adapter ${adapter.namespace} declares semantic operations without planning capability.`);
  }
  if (adapter.schema.capabilities.transactions !== "none" && adapter.apply === undefined) {
    throw new TypeError(`Adapter ${adapter.namespace} declares transactions without apply capability.`);
  }
  if (adapter.mount !== undefined && !adapter.schema.edges.some(({ name, role }) => name === adapter.mount?.edge && role === "child")) {
    throw new TypeError(`Adapter ${adapter.namespace} mount edge is absent from its schema.`);
  }
};

export interface ApplyResult {
  readonly applied: number;
  readonly diagnostics: readonly Diagnostic[];
}
