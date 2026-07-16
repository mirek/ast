import { createHash } from "node:crypto";

import type { Adapter, AdapterPluginIdentity, Operation } from "./adapter.js";
import { defineDiagnostic } from "./diagnostic.js";
import type { Diagnostic } from "./diagnostic.js";
import { immutableCopy } from "./immutable.js";
import type { NamespacedName, Resource, Revision, SourceRange } from "./model.js";

export type ChangeRisk = "safe" | "destructive" | "irreversible";

export interface ChangePrecondition {
  readonly resource: string;
  readonly uri: string;
  readonly expectedRevision?: Revision;
  readonly expectation: "exists" | "absent";
  readonly description: string;
}

export interface ChangeRegion {
  readonly uri: string;
  readonly range?: SourceRange;
}

export interface TextChangePreview {
  readonly kind: "text";
  readonly uri: string;
  readonly before: string;
  readonly after: string;
  readonly sensitive: boolean;
}

export interface ChangeTransaction {
  readonly key: string;
  readonly atomic: boolean;
  readonly rollback: "none" | "adapter";
  readonly compensation: "none" | "adapter";
}

export interface Change<Payload = unknown> {
  readonly adapter: string;
  readonly resource: string;
  readonly resourceUri: string;
  readonly resourceRevision?: Revision;
  readonly kind: NamespacedName;
  readonly risk: ChangeRisk;
  readonly summary: string;
  readonly reversible: boolean;
  readonly payload: Payload;
  readonly preconditions: readonly ChangePrecondition[];
  readonly regions: readonly ChangeRegion[];
  readonly preview?: TextChangePreview;
  readonly transaction?: ChangeTransaction;
}

export interface PlannedOperation {
  readonly id: string;
  readonly adapter: Adapter;
  readonly operation: Operation;
  readonly dependsOn?: readonly string[];
}

export interface PlannedChange extends Change {
  readonly id: string;
  readonly operationId: string;
}

export interface PlanAdapterIdentity {
  readonly namespace: string;
  readonly schemaVersion: string;
  readonly plugin?: AdapterPluginIdentity;
}

export interface PlanResourceIdentity {
  readonly adapter: string;
  readonly id: string;
  readonly uri: string;
  readonly revision?: Revision;
}

export interface TransactionGroup {
  readonly id: string;
  readonly adapter: string;
  readonly resource: string;
  readonly changeIds: readonly string[];
  readonly dependsOn: readonly string[];
  readonly atomic: boolean;
  readonly rollback: "none" | "adapter";
  readonly compensation: "none" | "adapter";
  readonly partialApplication: "none" | "possible";
}

export interface ChangePlan {
  readonly formatVersion: "1";
  readonly adapters: readonly PlanAdapterIdentity[];
  readonly resources: readonly PlanResourceIdentity[];
  readonly changes: readonly PlannedChange[];
  readonly diagnostics: readonly Diagnostic[];
  readonly transactionGroups: readonly TransactionGroup[];
}

export interface RenderChangePlanOptions {
  readonly includeSensitive?: boolean;
}

export interface DeserializeChangePlanOptions {
  readonly adapters: readonly Adapter[];
  readonly resources?: readonly PlanResourceIdentity[];
}

export interface ApplyChangePlanOptions {
  readonly signal?: AbortSignal;
  readonly failurePolicy?: "stop" | "continue-independent";
}

const samePluginIdentity = (
  left: AdapterPluginIdentity | undefined,
  right: AdapterPluginIdentity | undefined,
): boolean => left === undefined || right === undefined
  ? left === right
  : left.apiVersion === right.apiVersion &&
    left.name === right.name &&
    left.version === right.version &&
    left.integrity === right.integrity;

export type ApplyGroupStatus =
  | "applied"
  | "failed"
  | "skipped-dependency"
  | "skipped-policy";

export interface ApplyGroupResult {
  readonly id: string;
  readonly status: ApplyGroupStatus;
  readonly appliedChanges: number;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ChangePlanApplyResult {
  readonly groups: readonly ApplyGroupResult[];
  readonly appliedChanges: number;
  readonly partialApplication: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  signal?.throwIfAborted();
};

const assertNonEmpty = (label: string, value: string): void => {
  if (value.length === 0) throw new TypeError(`${label} must not be empty.`);
};

const operationOrder = (requests: readonly PlannedOperation[]): readonly PlannedOperation[] => {
  const byId = new Map<string, PlannedOperation>();
  for (const request of requests) {
    assertNonEmpty("Planned operation identifier", request.id);
    if (byId.has(request.id)) {
      throw new TypeError(`Duplicate planned operation identifier ${JSON.stringify(request.id)}.`);
    }
    byId.set(request.id, request);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: PlannedOperation[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new TypeError("Planned operation dependencies contain a cycle.");
    const request = byId.get(id);
    if (request === undefined) throw new TypeError(`Unknown planned operation dependency ${id}.`);
    visiting.add(id);
    for (const dependency of request.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(request);
  };
  for (const request of requests) visit(request.id);
  return Object.freeze(ordered);
};

const assertSerializable = (value: unknown): void => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("value has no JSON representation");
  } catch (error) {
    throw new TypeError("Adapter change payload must be JSON serializable.", { cause: error });
  }
};

const asChange = (value: unknown, adapter: Adapter): Change => {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`Adapter ${adapter.namespace} returned an invalid change.`);
  }
  const candidate = value as Partial<Change>;
  if (
    candidate.adapter !== adapter.namespace ||
    typeof candidate.resource !== "string" ||
    typeof candidate.resourceUri !== "string" ||
    typeof candidate.kind !== "string" ||
    !candidate.kind.startsWith(`${adapter.namespace}::`) ||
    !["safe", "destructive", "irreversible"].includes(candidate.risk ?? "") ||
    typeof candidate.summary !== "string" ||
    typeof candidate.reversible !== "boolean" ||
    !Array.isArray(candidate.preconditions) ||
    !Array.isArray(candidate.regions)
  ) {
    throw new TypeError(`Adapter ${adapter.namespace} returned an invalid change contract.`);
  }
  assertSerializable(candidate.payload);
  return immutableCopy(candidate as Change);
};

const regionsOverlap = (left: ChangeRegion, right: ChangeRegion): boolean => {
  if (left.uri !== right.uri) return false;
  if (left.range === undefined || right.range === undefined) return true;
  if (
    left.range.start === left.range.end &&
    right.range.start === right.range.end
  ) {
    return left.range.start === right.range.start;
  }
  if (left.range.start === left.range.end) {
    return left.range.start >= right.range.start && left.range.start <= right.range.end;
  }
  if (right.range.start === right.range.end) {
    return right.range.start >= left.range.start && right.range.start <= left.range.end;
  }
  return left.range.start < right.range.end && right.range.start < left.range.end;
};

const conflictDiagnostics = (changes: readonly PlannedChange[]): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  for (let leftIndex = 0; leftIndex < changes.length; leftIndex += 1) {
    const left = changes[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < changes.length; rightIndex += 1) {
      const right = changes[rightIndex];
      if (right === undefined) continue;
      if (!left.regions.some((region) => right.regions.some((other) => regionsOverlap(region, other)))) {
        continue;
      }
      diagnostics.push(
        defineDiagnostic({
          code: "plan.overlapping-changes",
          severity: "error",
          message: `Changes ${left.id} and ${right.id} overlap the same logical source region.`,
          locations: [
            { kind: "change", change: left.id, operation: left.kind },
            { kind: "change", change: right.id, operation: right.kind },
          ],
        }),
      );
    }
  }
  return Object.freeze(diagnostics);
};

const uniqueAdapters = (requests: readonly PlannedOperation[]): readonly PlanAdapterIdentity[] => {
  const values = new Map<string, PlanAdapterIdentity>();
  for (const { adapter } of requests) {
    const existing = values.get(adapter.namespace);
    if (existing !== undefined && (
      existing.schemaVersion !== adapter.schema.version ||
      !samePluginIdentity(existing.plugin, adapter.plugin)
    )) {
      throw new TypeError(`Adapter ${adapter.namespace} has conflicting identities.`);
    }
    values.set(adapter.namespace, {
      namespace: adapter.namespace,
      schemaVersion: adapter.schema.version,
      ...(adapter.plugin === undefined ? {} : { plugin: adapter.plugin }),
    });
  }
  return Object.freeze([...values.values()].map((value) => Object.freeze(value)));
};

const uniqueResources = (changes: readonly PlannedChange[]): readonly PlanResourceIdentity[] => {
  const values = new Map<string, PlanResourceIdentity>();
  for (const change of changes) {
    const key = `${change.adapter}\0${change.resource}`;
    const value: PlanResourceIdentity = {
      adapter: change.adapter,
      id: change.resource,
      uri: change.resourceUri,
      ...(change.resourceRevision === undefined
        ? {}
        : { revision: change.resourceRevision }),
    };
    const existing = values.get(key);
    if (
      existing !== undefined &&
      (existing.uri !== value.uri || existing.revision !== value.revision)
    ) {
      throw new TypeError(`Change resource identity ${change.resource} is inconsistent.`);
    }
    values.set(key, value);
  }
  return Object.freeze([...values.values()].map((value) => Object.freeze(value)));
};

const buildGroups = (
  changes: readonly PlannedChange[],
  requests: readonly PlannedOperation[],
): readonly TransactionGroup[] => {
  interface MutableGroup {
    id: string;
    adapter: string;
    resource: string;
    changeIds: string[];
    operationIds: Set<string>;
    dependsOn: Set<string>;
    atomic: boolean;
    rollback: "none" | "adapter";
    compensation: "none" | "adapter";
  }
  const groups: MutableGroup[] = [];
  const byKey = new Map<string, MutableGroup>();
  const operationGroups = new Map<string, Set<string>>();
  for (const change of changes) {
    const key = change.transaction === undefined
      ? change.id
      : `${change.adapter}\0${change.transaction.key}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = {
        id: `group:${change.id}`,
        adapter: change.adapter,
        resource: change.resource,
        changeIds: [],
        operationIds: new Set(),
        dependsOn: new Set(),
        atomic: change.transaction?.atomic ?? false,
        rollback: change.transaction?.rollback ?? "none",
        compensation: change.transaction?.compensation ?? "none",
      };
      groups.push(group);
      byKey.set(key, group);
    }
    group.changeIds.push(change.id);
    group.operationIds.add(change.operationId);
    const ids = operationGroups.get(change.operationId) ?? new Set<string>();
    ids.add(group.id);
    operationGroups.set(change.operationId, ids);
  }
  const dependencies = new Map(requests.map((request) => [request.id, request.dependsOn ?? []]));
  for (const group of groups) {
    for (const operationId of group.operationIds) {
      for (const dependency of dependencies.get(operationId) ?? []) {
        for (const dependencyGroup of operationGroups.get(dependency) ?? []) {
          if (dependencyGroup !== group.id) group.dependsOn.add(dependencyGroup);
        }
      }
    }
  }
  return Object.freeze(
    groups.map((group): TransactionGroup =>
      immutableCopy({
        id: group.id,
        adapter: group.adapter,
        resource: group.resource,
        changeIds: group.changeIds,
        dependsOn: [...group.dependsOn],
        atomic: group.atomic,
        rollback: group.rollback,
        compensation: group.compensation,
        partialApplication: group.atomic || group.changeIds.length === 1
          ? "none"
          : "possible",
      }),
    ),
  );
};

export const planOperations = async (
  requests: readonly PlannedOperation[],
  options: { readonly signal?: AbortSignal } = {},
): Promise<ChangePlan> => {
  const ordered = operationOrder(requests);
  const changes: PlannedChange[] = [];
  const planningDiagnostics: Diagnostic[] = [];
  for (const request of ordered) {
    throwIfAborted(options.signal);
    if (request.adapter.planning === undefined) {
      throw new TypeError(`Adapter ${request.adapter.namespace} does not provide planning capability.`);
    }
    if (!request.operation.kind.startsWith(`${request.adapter.namespace}::`)) {
      throw new TypeError(`Operation ${request.operation.kind} does not belong to adapter ${request.adapter.namespace}.`);
    }
    const diagnosticSource = request.adapter as Adapter & {
      diagnostics?: () => readonly Diagnostic[];
    };
    const beforeDiagnostics = diagnosticSource.diagnostics?.().length ?? 0;
    // Planning stays sequential to retain deterministic operation and change order.
    // oxlint-disable-next-line no-await-in-loop
    const planned = await request.adapter.planning.plan(
      request.operation,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    planningDiagnostics.push(...(diagnosticSource.diagnostics?.().slice(beforeDiagnostics) ?? []));
    for (const [index, value] of planned.entries()) {
      const change = asChange(value, request.adapter);
      changes.push(
        immutableCopy({
          ...change,
          id: `${request.id}:${index}`,
          operationId: request.id,
        }),
      );
    }
  }
  const frozenChanges = Object.freeze(changes);
  return immutableCopy({
    formatVersion: "1",
    adapters: uniqueAdapters(ordered),
    resources: uniqueResources(frozenChanges),
    changes: frozenChanges,
    diagnostics: [...planningDiagnostics, ...conflictDiagnostics(frozenChanges)],
    transactionGroups: buildGroups(frozenChanges, ordered),
  });
};

const textDiff = (preview: TextChangePreview): readonly string[] => {
  const before = preview.before.split(/\r?\n/u);
  const after = preview.after.split(/\r?\n/u);
  return [
    `--- ${preview.uri}`,
    `+++ ${preview.uri}`,
    "@@",
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
  ];
};

export const renderChangePlan = (
  plan: ChangePlan,
  options: RenderChangePlanOptions = {},
): string => {
  const lines: string[] = [];
  for (const change of plan.changes) {
    lines.push(`[${change.risk.toUpperCase()}] ${change.summary}`);
    if (change.preview !== undefined) {
      if (change.preview.sensitive && options.includeSensitive !== true) {
        lines.push("  (content redacted)");
      } else {
        lines.push(...textDiff(change.preview));
      }
    }
  }
  for (const diagnostic of plan.diagnostics) {
    lines.push(`[${diagnostic.severity.toUpperCase()} ${diagnostic.code}] ${diagnostic.message}`);
  }
  return `${lines.join("\n")}\n`;
};

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");

export const serializeChangePlan = (plan: ChangePlan): string => {
  const body = JSON.stringify(plan);
  return JSON.stringify({ integrity: `sha256:${digest(body)}`, plan });
};

const validateAdapters = (plan: ChangePlan, adapters: readonly Adapter[]): void => {
  const available = new Map(adapters.map((adapter) => [adapter.namespace, adapter]));
  for (const identity of plan.adapters) {
    const adapter = available.get(identity.namespace);
    if (adapter === undefined) throw new TypeError(`Missing adapter ${identity.namespace}.`);
    if (adapter.schema.version !== identity.schemaVersion) {
      throw new TypeError(
        `Adapter ${identity.namespace} schema version ${adapter.schema.version} does not match saved schema version ${identity.schemaVersion}.`,
      );
    }
    if (!samePluginIdentity(adapter.plugin, identity.plugin)) {
      throw new TypeError(`Adapter ${identity.namespace} plugin identity does not match the saved plan.`);
    }
  }
};

const validateResources = (
  plan: ChangePlan,
  resources: readonly PlanResourceIdentity[],
): void => {
  const expected = new Map(resources.map((resource) => [`${resource.adapter}\0${resource.id}`, resource]));
  for (const resource of plan.resources) {
    const candidate = expected.get(`${resource.adapter}\0${resource.id}`);
    if (
      candidate === undefined ||
      candidate.uri !== resource.uri ||
      candidate.revision !== resource.revision
    ) {
      throw new TypeError(`Saved resource identity ${resource.adapter}:${resource.id} does not match.`);
    }
  }
};

export const deserializeChangePlan = (
  serialized: string,
  options: DeserializeChangePlanOptions,
): ChangePlan => {
  const envelope = JSON.parse(serialized) as { readonly integrity?: unknown; readonly plan?: unknown };
  if (typeof envelope.integrity !== "string" || envelope.plan === undefined) {
    throw new TypeError("Invalid saved change-plan envelope.");
  }
  const body = JSON.stringify(envelope.plan);
  if (envelope.integrity !== `sha256:${digest(body)}`) {
    throw new TypeError("Saved change-plan integrity check failed.");
  }
  const plan = envelope.plan as ChangePlan;
  if (plan.formatVersion !== "1" || !Array.isArray(plan.changes)) {
    throw new TypeError("Unsupported saved change-plan format.");
  }
  validateAdapters(plan, options.adapters);
  if (options.resources !== undefined) validateResources(plan, options.resources);
  return immutableCopy(plan);
};

const applyFailure = (group: TransactionGroup, error: unknown): Diagnostic =>
  defineDiagnostic({
    code: "apply.group-failed",
    severity: "error",
    message: `Transaction group ${group.id} failed: ${error instanceof Error ? error.message : "unknown adapter failure"}.`,
    locations: group.changeIds.map((change) => ({ kind: "change" as const, change })),
  });

export const applyChangePlan = async (
  plan: ChangePlan,
  adapters: readonly Adapter[],
  options: ApplyChangePlanOptions = {},
): Promise<ChangePlanApplyResult> => {
  if (plan.diagnostics.some(({ severity }) => severity === "error")) {
    throw new TypeError("Change plan contains error diagnostics and cannot be applied.");
  }
  validateAdapters(plan, adapters);
  const byAdapter = new Map(adapters.map((adapter) => [adapter.namespace, adapter]));
  const byChange = new Map(plan.changes.map((change) => [change.id, change]));
  const statuses = new Map<string, ApplyGroupStatus>();
  const groups: ApplyGroupResult[] = [];
  const diagnostics: Diagnostic[] = [];
  let failed = false;
  let appliedChanges = 0;
  for (const group of plan.transactionGroups) {
    throwIfAborted(options.signal);
    const dependencyFailed = group.dependsOn.some(
      (id) => statuses.get(id) !== "applied",
    );
    if (dependencyFailed) {
      const result = immutableCopy({
        id: group.id,
        status: "skipped-dependency" as const,
        appliedChanges: 0,
        diagnostics: [],
      });
      statuses.set(group.id, result.status);
      groups.push(result);
      continue;
    }
    if (failed && (options.failurePolicy ?? "stop") === "stop") {
      const result = immutableCopy({
        id: group.id,
        status: "skipped-policy" as const,
        appliedChanges: 0,
        diagnostics: [],
      });
      statuses.set(group.id, result.status);
      groups.push(result);
      continue;
    }
    const adapter = byAdapter.get(group.adapter);
    const changes = group.changeIds.map((id) => byChange.get(id)).filter(Boolean) as PlannedChange[];
    try {
      if (adapter?.apply === undefined) {
        throw new TypeError(`Adapter ${group.adapter} does not provide apply capability.`);
      }
      // Group application is intentionally sequential to preserve dependency order.
      // oxlint-disable-next-line no-await-in-loop
      const applied = await adapter.apply.apply(
        changes,
        options.signal === undefined ? {} : { signal: options.signal },
      );
      const adapterResult = applied as { readonly applied?: unknown; readonly diagnostics?: unknown };
      const count = typeof adapterResult.applied === "number" ? adapterResult.applied : 0;
      const adapterDiagnostics = Array.isArray(adapterResult.diagnostics)
        ? adapterResult.diagnostics as Diagnostic[]
        : [];
      if (!Number.isSafeInteger(count) || count < 0 || count > changes.length) {
        throw new TypeError("Adapter returned an invalid applied-change count.");
      }
      const complete =
        count === changes.length &&
        !adapterDiagnostics.some(({ severity }) => severity === "error");
      const hasAdapterError = adapterDiagnostics.some(({ severity }) => severity === "error");
      const resultDiagnostics = complete || hasAdapterError
        ? adapterDiagnostics
        : [
            ...adapterDiagnostics,
            applyFailure(group, new Error("adapter did not apply every change")),
          ];
      const result = immutableCopy({
        id: group.id,
        status: complete ? "applied" as const : "failed" as const,
        appliedChanges: count,
        diagnostics: resultDiagnostics,
      });
      statuses.set(group.id, result.status);
      groups.push(result);
      diagnostics.push(...resultDiagnostics);
      appliedChanges += count;
      if (!complete) failed = true;
    } catch (error) {
      const diagnostic = applyFailure(group, error);
      const result = immutableCopy({
        id: group.id,
        status: "failed" as const,
        appliedChanges: 0,
        diagnostics: [diagnostic],
      });
      statuses.set(group.id, result.status);
      groups.push(result);
      diagnostics.push(diagnostic);
      failed = true;
    }
  }
  return immutableCopy({
    groups,
    appliedChanges,
    partialApplication: failed && appliedChanges > 0,
    diagnostics,
  });
};

export const resourceIdentity = (resource: Resource): PlanResourceIdentity =>
  immutableCopy({
    adapter: resource.adapter,
    id: resource.id,
    uri: resource.uri,
    ...(resource.revision === undefined ? {} : { revision: resource.revision }),
  });
