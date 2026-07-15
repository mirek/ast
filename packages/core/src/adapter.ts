import type { Diagnostic } from "./diagnostic.js";
import type {
  Edge,
  EdgeRequest,
  NodeId,
  NodeSnapshot,
  OperationKind,
  Resource,
  Scalar,
} from "./model.js";
import type { AdapterSchema } from "./schema.js";

export interface SourceDescriptor {
  readonly uri: string;
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

export interface Adapter {
  readonly namespace: string;
  readonly schema: AdapterSchema;
  readonly read?: ReadCapability;
  readonly planning?: PlanningCapability;
  readonly apply?: ApplyCapability;
}

export interface ApplyResult {
  readonly applied: number;
  readonly diagnostics: readonly Diagnostic[];
}
