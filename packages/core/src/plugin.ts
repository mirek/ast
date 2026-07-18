import type { Adapter, AdapterPluginIdentity, Operation } from "./adapter.js";
import { validateAdapter } from "./adapter.js";
import { defineDslArgumentSchema } from "./dsl.js";
import type { DslArguments, DslArgumentSchema, DslEnvironment } from "./dsl.js";
import { immutableCopy } from "./immutable.js";
import { assertNamespace, assertNamespacedName } from "./model.js";
import type { NamespacedName, NodeSnapshot, Scalar } from "./model.js";
import type { CaptureMap, NavigableNodeHandle, Query } from "./query.js";
import type { AdapterSchema, ScalarType } from "./schema.js";
import { defineAdapterSchema } from "./schema.js";
import type { SelectorSourceMode } from "./selector.js";

export type PluginPower =
  | "resource:read"
  | "resource:write"
  | "filesystem:read"
  | "filesystem:write"
  | "network:read"
  | "network:write"
  | "process:execute"
  | "credentials:read"
  | "native-modules:load";

export interface PluginContributionManifest {
  readonly adapters: readonly string[];
  readonly schemas: readonly string[];
  readonly resolvers: readonly NamespacedName[];
  readonly mounts: readonly NamespacedName[];
  readonly operations: readonly NamespacedName[];
  readonly predicates: readonly NamespacedName[];
  readonly functions: readonly NamespacedName[];
  readonly renderers: readonly NamespacedName[];
  readonly diffProviders: readonly NamespacedName[];
  readonly optimizerRules: readonly NamespacedName[];
}

export interface PluginManifest {
  readonly apiVersion: "1";
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly namespaces: readonly string[];
  readonly powers: readonly PluginPower[];
  readonly contributions: PluginContributionManifest;
}

export interface PluginResolverContribution {
  readonly name: NamespacedName;
  readonly adapter: Adapter;
  readonly selectorSource: SelectorSourceMode;
  readonly arguments: DslArgumentSchema;
  treeView?(args: DslArguments): NamespacedName | undefined;
  open(args: DslArguments): Query<NavigableNodeHandle>;
}

export interface PluginMountContribution {
  readonly name: NamespacedName;
  readonly adapter: Adapter;
  readonly arguments: DslArgumentSchema;
  treeView?(args: DslArguments): NamespacedName | undefined;
  mount(
    query: Query<NavigableNodeHandle, CaptureMap>,
    args: DslArguments,
  ): Query<NavigableNodeHandle, CaptureMap>;
}

export interface PluginOperationContribution {
  readonly name: NamespacedName;
  readonly adapter: Adapter;
  create(target: NavigableNodeHandle, args: DslArguments): Operation;
}

export interface PluginPredicateContribution {
  readonly name: NamespacedName;
  readonly parameters: readonly ScalarType[];
  test(value: NodeSnapshot, args: readonly Scalar[]): boolean;
}

export interface PluginFunctionContribution {
  readonly name: NamespacedName;
  readonly parameters: readonly ScalarType[];
  readonly returns: ScalarType;
  call(args: readonly Scalar[]): Scalar;
}

export interface PluginRendererContribution {
  readonly name: NamespacedName;
  render(value: unknown): string;
}

export interface PluginDiffProviderContribution {
  readonly name: NamespacedName;
  render(before: unknown, after: unknown): string;
}

export type PluginOptimizerEquivalence = "identity";
export interface PluginOptimizerRule {
  readonly name: NamespacedName;
  readonly equivalence: PluginOptimizerEquivalence;
}

export interface PluginContributions {
  readonly adapters?: readonly Adapter[];
  readonly schemas?: readonly AdapterSchema[];
  readonly resolvers?: readonly PluginResolverContribution[];
  readonly mounts?: readonly PluginMountContribution[];
  readonly operations?: readonly PluginOperationContribution[];
  readonly predicates?: readonly PluginPredicateContribution[];
  readonly functions?: readonly PluginFunctionContribution[];
  readonly renderers?: readonly PluginRendererContribution[];
  readonly diffProviders?: readonly PluginDiffProviderContribution[];
  readonly optimizerRules?: readonly PluginOptimizerRule[];
}

export interface PluginModule {
  readonly manifest: PluginManifest;
  readonly contributions: PluginContributions;
}

export interface PluginAliases {
  readonly namespaces?: Readonly<Record<string, string>>;
  readonly sources?: Readonly<Record<string, NamespacedName>>;
  readonly mounts?: Readonly<Record<string, NamespacedName>>;
  readonly operations?: Readonly<Record<string, NamespacedName>>;
  readonly predicates?: Readonly<Record<string, NamespacedName>>;
  readonly functions?: Readonly<Record<string, NamespacedName>>;
  readonly renderers?: Readonly<Record<string, NamespacedName>>;
  readonly diffProviders?: Readonly<Record<string, NamespacedName>>;
}

export interface PluginPolicy {
  readonly allow: readonly string[];
  readonly powers?: Readonly<Record<string, readonly PluginPower[]>>;
  readonly aliases?: PluginAliases;
  readonly reservedNamespaces?: readonly string[];
}

interface ResolvedPluginAliases {
  readonly namespaces: Readonly<Record<string, string>>;
  readonly sources: Readonly<Record<string, NamespacedName>>;
  readonly mounts: Readonly<Record<string, NamespacedName>>;
  readonly operations: Readonly<Record<string, NamespacedName>>;
  readonly predicates: Readonly<Record<string, NamespacedName>>;
  readonly functions: Readonly<Record<string, NamespacedName>>;
  readonly renderers: Readonly<Record<string, NamespacedName>>;
  readonly diffProviders: Readonly<Record<string, NamespacedName>>;
}

export interface PluginRegistry {
  readonly plugins: readonly PluginManifest[];
  readonly adapters: readonly Adapter[];
  readonly schemas: Readonly<Record<string, AdapterSchema>>;
  readonly resolvers: Readonly<Record<NamespacedName, PluginResolverContribution>>;
  readonly mounts: Readonly<Record<NamespacedName, PluginMountContribution>>;
  readonly operations: Readonly<Record<NamespacedName, PluginOperationContribution>>;
  readonly predicates: Readonly<Record<NamespacedName, PluginPredicateContribution>>;
  readonly functions: Readonly<Record<NamespacedName, PluginFunctionContribution>>;
  readonly renderers: Readonly<Record<NamespacedName, PluginRendererContribution>>;
  readonly diffProviders: Readonly<Record<NamespacedName, PluginDiffProviderContribution>>;
  readonly optimizerRules: Readonly<Record<NamespacedName, PluginOptimizerRule>>;
  readonly aliases: ResolvedPluginAliases;
  readonly dslEnvironment: DslEnvironment;
}

export class PluginError extends TypeError {
  override readonly name = "PluginError";
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

const fail = (code: string, message: string, cause?: unknown): never => {
  throw new PluginError(code, message, cause === undefined ? undefined : { cause });
};

const semver = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const aliasName = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const powers = new Set<PluginPower>([
  "resource:read", "resource:write", "filesystem:read", "filesystem:write",
  "network:read", "network:write", "process:execute", "credentials:read",
  "native-modules:load",
]);
const contributionKeys = [
  "adapters", "schemas", "resolvers", "mounts", "operations", "predicates",
  "functions", "renderers", "diffProviders", "optimizerRules",
] as const;
type ContributionKey = typeof contributionKeys[number];

const assertUnique = (code: string, label: string, values: readonly string[]): void => {
  if (new Set(values).size !== values.length) fail(code, `${label} must be unique.`);
};

const owner = (name: NamespacedName): string => name.slice(0, name.indexOf("::"));
const validateManifest = (value: PluginManifest): PluginManifest => {
  if (value === null || typeof value !== "object") return fail("plugin.invalid-manifest", "Plugin manifest must be an object.");
  if (value.apiVersion !== "1") return fail("plugin.incompatible-api", `Plugin ${JSON.stringify(value.name)} uses unsupported API version ${JSON.stringify(value.apiVersion)}.`);
  if (!packageName.test(value.name)) return fail("plugin.invalid-manifest", `Invalid plugin package name ${JSON.stringify(value.name)}.`);
  if (!semver.test(value.version)) return fail("plugin.invalid-manifest", `Plugin ${value.name} must declare a semantic version.`);
  if (typeof value.integrity !== "string" || !value.integrity.startsWith("sha256:") || value.integrity.length <= "sha256:".length) return fail("plugin.invalid-manifest", `Plugin ${value.name} must declare build integrity.`);
  if (!Array.isArray(value.namespaces) || value.namespaces.length === 0) return fail("plugin.invalid-manifest", `Plugin ${value.name} must own at least one namespace.`);
  try { for (const namespace of value.namespaces) assertNamespace(namespace); }
  catch (error) { return fail("plugin.invalid-manifest", `Plugin ${value.name} declares an invalid namespace.`, error); }
  assertUnique("plugin.duplicate-namespace", `Plugin ${value.name} namespaces`, value.namespaces);
  if (!Array.isArray(value.powers)) return fail("plugin.invalid-manifest", `Plugin ${value.name} powers must be an array.`);
  for (const power of value.powers) if (!powers.has(power)) return fail("plugin.invalid-power", `Plugin ${value.name} declares unknown power ${JSON.stringify(power)}.`);
  assertUnique("plugin.invalid-power", `Plugin ${value.name} powers`, value.powers);
  if (value.contributions === null || typeof value.contributions !== "object") return fail("plugin.invalid-manifest", `Plugin ${value.name} must declare contributions.`);
  for (const key of contributionKeys) {
    const names = value.contributions[key];
    if (!Array.isArray(names)) return fail("plugin.invalid-manifest", `Plugin ${value.name} contribution list ${key} must be an array.`);
    assertUnique("plugin.duplicate-contribution", `Plugin ${value.name} ${key}`, names);
    for (const name of names) {
      try {
        if (key === "adapters" || key === "schemas") assertNamespace(name);
        else assertNamespacedName(name as NamespacedName);
      } catch (error) { return fail("plugin.invalid-manifest", `Plugin ${value.name} declares invalid ${key} contribution ${JSON.stringify(name)}.`, error); }
      const namespace = key === "adapters" || key === "schemas" ? name : owner(name as NamespacedName);
      if (!value.namespaces.includes(namespace)) return fail("plugin.foreign-namespace", `Plugin ${value.name} does not own namespace ${namespace}.`);
    }
  }
  return immutableCopy(value);
};

export const definePluginManifest = <const T extends PluginManifest>(value: T): T =>
  validateManifest(value) as T;

const actualNames = (contributions: PluginContributions, key: ContributionKey): readonly string[] => {
  const values = contributions[key];
  if (values === undefined) return [];
  if (!Array.isArray(values)) return fail("plugin.invalid-module", `Plugin contribution ${key} must be an array.`);
  if (key === "adapters") return values.map(({ namespace }) => namespace);
  if (key === "schemas") return values.map(({ namespace }) => namespace);
  return values.map(({ name }) => name);
};

const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && [...left].toSorted().every((value, index) => value === [...right].toSorted()[index]);

const recordOf = <T extends { readonly name: NamespacedName }>(
  label: string,
  values: readonly T[],
): Readonly<Record<NamespacedName, T>> => {
  const entries: [NamespacedName, T][] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.name)) fail("plugin.duplicate-contribution", `Duplicate ${label} ${value.name}.`);
    seen.add(value.name);
    entries.push([value.name, Object.freeze(value)]);
  }
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<NamespacedName, T>>;
};

const resolveAliases = <T>(
  label: string,
  aliases: Readonly<Record<string, string>> | undefined,
  available: Readonly<Record<string, T>>,
): Readonly<Record<string, string>> => {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [alias, target] of Object.entries(aliases ?? {})) {
    if (!aliasName.test(alias)) fail("plugin.invalid-alias", `Invalid ${label} alias ${JSON.stringify(alias)}.`);
    if (available[target] === undefined) fail("plugin.unknown-alias-target", `Unknown ${label} alias target ${JSON.stringify(target)}.`);
    result[alias] = target;
  }
  return Object.freeze(result);
};

export const registerPlugins = (
  modules: readonly PluginModule[],
  policy: PluginPolicy,
): PluginRegistry => {
  assertUnique("plugin.duplicate-policy-entry", "Plugin allowlist entries", policy.allow);
  const allowed = new Set(policy.allow);
  const seenPackages = new Set<string>();
  const seenNamespaces = new Map<string, string>();
  for (const namespace of policy.reservedNamespaces ?? []) {
    try { assertNamespace(namespace); }
    catch (error) { return fail("plugin.invalid-policy", `Invalid reserved namespace ${JSON.stringify(namespace)}.`, error); }
    if (seenNamespaces.has(namespace)) fail("plugin.duplicate-policy-entry", `Reserved namespace ${namespace} appears more than once.`);
    seenNamespaces.set(namespace, "the host runtime");
  }
  const manifests: PluginManifest[] = [];
  const adapters: Adapter[] = [];
  const schemas: AdapterSchema[] = [];
  const resolvers: PluginResolverContribution[] = [];
  const mounts: PluginMountContribution[] = [];
  const operations: PluginOperationContribution[] = [];
  const predicates: PluginPredicateContribution[] = [];
  const functions: PluginFunctionContribution[] = [];
  const renderers: PluginRendererContribution[] = [];
  const diffProviders: PluginDiffProviderContribution[] = [];
  const optimizerRules: PluginOptimizerRule[] = [];

  for (const module of modules) {
    if (module === null || typeof module !== "object" || module.contributions === null || typeof module.contributions !== "object") {
      fail("plugin.invalid-module", "Plugin module must contain a manifest and contributions object.");
    }
    const manifest = validateManifest(module.manifest);
    if (seenPackages.has(manifest.name)) fail("plugin.duplicate", `Plugin ${manifest.name} was loaded more than once.`);
    seenPackages.add(manifest.name);
    if (!allowed.has(manifest.name)) fail("plugin.not-allowlisted", `Plugin ${manifest.name} is not allowlisted.`);
    const approved = new Set(policy.powers?.[manifest.name] ?? []);
    for (const power of manifest.powers) if (!approved.has(power)) fail("plugin.unauthorized-power", `Plugin ${manifest.name} requires unauthorized power ${power}.`);
    for (const key of contributionKeys) {
      const declared = manifest.contributions[key];
      const actual = actualNames(module.contributions, key);
      if (!sameNames(declared, actual)) fail("plugin.contribution-mismatch", `Plugin ${manifest.name} ${key} do not match its manifest.`);
    }
    for (const namespace of manifest.namespaces) {
      const existing = seenNamespaces.get(namespace);
      if (existing !== undefined) fail("plugin.duplicate-namespace", `Namespace ${namespace} is owned by both ${existing} and ${manifest.name}.`);
      seenNamespaces.set(namespace, manifest.name);
    }
    const identity: AdapterPluginIdentity = Object.freeze({
      apiVersion: manifest.apiVersion,
      name: manifest.name,
      version: manifest.version,
      integrity: manifest.integrity,
    });
    const declaredSchemas = new Map<string, AdapterSchema>();
    for (const schema of module.contributions.schemas ?? []) {
      if (schema.dynamic !== true) fail("plugin.static-schema", `Plugin schema ${schema.namespace} must declare dynamic: true.`);
      try {
        const validated = defineAdapterSchema(schema);
        declaredSchemas.set(validated.namespace, validated);
        schemas.push(validated);
      }
      catch (error) { return fail("plugin.invalid-schema", `Plugin ${manifest.name} schema ${schema.namespace} is invalid.`, error); }
    }
    const adapterMap = new Map<Adapter, Adapter>();
    for (const adapter of module.contributions.adapters ?? []) {
      if (adapter.schema.dynamic !== true) fail("plugin.static-schema", `Plugin adapter ${adapter.namespace} must expose a dynamic schema.`);
      const declared = declaredSchemas.get(adapter.namespace);
      const validatedSchema = declared ?? fail("plugin.schema-mismatch", `Plugin adapter ${adapter.namespace} has no declared dynamic schema.`);
      if (JSON.stringify(adapter.schema) !== JSON.stringify(validatedSchema)) {
        fail("plugin.schema-mismatch", `Plugin adapter ${adapter.namespace} does not match its declared dynamic schema.`);
      }
      try { validateAdapter(adapter); }
      catch (error) { return fail("plugin.invalid-adapter", `Plugin ${manifest.name} adapter ${adapter.namespace} is invalid.`, error); }
      const wrapped = Object.freeze({ ...adapter, schema: validatedSchema, plugin: identity });
      adapterMap.set(adapter, wrapped);
      adapters.push(wrapped);
    }
    const normalizedAdapter = (adapter: Adapter): Adapter => {
      const normalized = adapterMap.get(adapter);
      if (normalized === undefined) return fail("plugin.foreign-adapter", `Plugin ${manifest.name} contribution references an undeclared adapter.`);
      return normalized;
    };
    const normalizeBound = <T extends { readonly name: NamespacedName; readonly adapter: Adapter }>(value: T): T => {
      const adapter = normalizedAdapter(value.adapter);
      if (owner(value.name) !== adapter.namespace) fail("plugin.foreign-namespace", `Contribution ${value.name} does not belong to adapter ${adapter.namespace}.`);
      return Object.freeze({ ...value, adapter });
    };
    const contributionArguments = (
      label: string,
      value: { readonly name: NamespacedName; readonly arguments: DslArgumentSchema },
    ): DslArgumentSchema => {
      try {
        return defineDslArgumentSchema(value.arguments);
      } catch (error) {
        return fail(
          "plugin.invalid-argument-schema",
          `Plugin ${label} ${value.name} has an invalid DSL argument schema.`,
          error,
        );
      }
    };
    resolvers.push(...(module.contributions.resolvers ?? []).map((value) => {
      if (value.selectorSource !== "roots" && value.selectorSource !== "selection") {
        fail(
          "plugin.invalid-selector-source",
          `Plugin resolver ${value.name} must declare selectorSource as roots or selection.`,
        );
      }
      return normalizeBound({ ...value, arguments: contributionArguments("resolver", value) });
    }));
    mounts.push(...(module.contributions.mounts ?? []).map((value) =>
      normalizeBound({ ...value, arguments: contributionArguments("mount", value) })));
    operations.push(...(module.contributions.operations ?? []).map((value) => {
      const normalized = normalizeBound(value);
      if (!normalized.adapter.schema.operations.some(({ kind }) => kind === normalized.name)) fail("plugin.unknown-operation", `Plugin operation ${normalized.name} is absent from its schema.`);
      return normalized;
    }));
    const scalarTypes = new Set<ScalarType>(["string", "number", "boolean", "bigint", "null"]);
    const validateParameters = (label: string, value: {
      readonly name: NamespacedName;
      readonly parameters: readonly ScalarType[];
    }): void => {
      if (!manifest.namespaces.includes(owner(value.name))) {
        fail("plugin.foreign-namespace", `Plugin ${label} ${value.name} uses an undeclared namespace.`);
      }
      if (!Array.isArray(value.parameters) || value.parameters.some((type) => !scalarTypes.has(type))) {
        fail("plugin.invalid-query-extension", `Plugin ${label} ${value.name} has invalid scalar parameters.`);
      }
    };
    predicates.push(...(module.contributions.predicates ?? []).map((value) => {
      validateParameters("predicate", value);
      return Object.freeze({ ...value, parameters: Object.freeze([...value.parameters]) });
    }));
    functions.push(...(module.contributions.functions ?? []).map((value) => {
      validateParameters("function", value);
      if (!scalarTypes.has(value.returns)) {
        fail("plugin.invalid-query-extension", `Plugin function ${value.name} has an invalid scalar return type.`);
      }
      return Object.freeze({ ...value, parameters: Object.freeze([...value.parameters]) });
    }));
    renderers.push(...(module.contributions.renderers ?? []));
    diffProviders.push(...(module.contributions.diffProviders ?? []));
    for (const rule of module.contributions.optimizerRules ?? []) {
      if (rule.equivalence !== "identity") fail("plugin.invalid-optimizer-rule", `Plugin optimizer rule ${rule.name} declares an unsupported equivalence.`);
      optimizerRules.push(rule);
    }
    manifests.push(manifest);
  }
  for (const name of allowed) if (!seenPackages.has(name)) fail("plugin.unknown", `Allowlisted plugin ${name} was not loaded.`);

  const schemaRecord = Object.freeze(Object.fromEntries(schemas.map((schema) => [schema.namespace, schema])));
  const resolverRecord = recordOf("resolver", resolvers);
  const mountRecord = recordOf("mount", mounts);
  const operationRecord = recordOf("operation", operations);
  const predicateRecord = recordOf("predicate", predicates);
  const functionRecord = recordOf("function", functions);
  const rendererRecord = recordOf("renderer", renderers);
  const diffRecord = recordOf("diff provider", diffProviders);
  const optimizerRecord = recordOf("optimizer rule", optimizerRules);
  const namespaceAvailable = Object.freeze(Object.fromEntries(schemas.map(({ namespace }) => [namespace, true])));
  const aliases: ResolvedPluginAliases = Object.freeze({
    namespaces: resolveAliases("namespace", policy.aliases?.namespaces, namespaceAvailable),
    sources: resolveAliases("source", policy.aliases?.sources, resolverRecord) as Readonly<Record<string, NamespacedName>>,
    mounts: resolveAliases("mount", policy.aliases?.mounts, mountRecord) as Readonly<Record<string, NamespacedName>>,
    operations: resolveAliases("operation", policy.aliases?.operations, operationRecord) as Readonly<Record<string, NamespacedName>>,
    predicates: resolveAliases("predicate", policy.aliases?.predicates, predicateRecord) as Readonly<Record<string, NamespacedName>>,
    functions: resolveAliases("function", policy.aliases?.functions, functionRecord) as Readonly<Record<string, NamespacedName>>,
    renderers: resolveAliases("renderer", policy.aliases?.renderers, rendererRecord) as Readonly<Record<string, NamespacedName>>,
    diffProviders: resolveAliases("diff provider", policy.aliases?.diffProviders, diffRecord) as Readonly<Record<string, NamespacedName>>,
  });
  const dslEnvironment: DslEnvironment = Object.freeze({
    sources: Object.freeze(Object.fromEntries(Object.entries(aliases.sources).map(([alias, target]) => [alias, resolverRecord[target]]))) as DslEnvironment["sources"],
    mounts: Object.freeze(Object.fromEntries(Object.entries(aliases.mounts).map(([alias, target]) => [alias, mountRecord[target]]))) as NonNullable<DslEnvironment["mounts"]>,
    operations: Object.freeze(Object.fromEntries(Object.entries(aliases.operations).map(([alias, target]) => [alias, operationRecord[target]]))) as NonNullable<DslEnvironment["operations"]>,
    predicates: Object.freeze({
      ...predicateRecord,
      ...Object.fromEntries(Object.entries(aliases.predicates).map(([alias, target]) => [alias, predicateRecord[target]])),
    }),
    functions: Object.freeze({
      ...functionRecord,
      ...Object.fromEntries(Object.entries(aliases.functions).map(([alias, target]) => [alias, functionRecord[target]])),
    }),
  });
  return Object.freeze({
    plugins: Object.freeze(manifests),
    adapters: Object.freeze(adapters),
    schemas: schemaRecord,
    resolvers: resolverRecord,
    mounts: mountRecord,
    operations: operationRecord,
    predicates: predicateRecord,
    functions: functionRecord,
    renderers: rendererRecord,
    diffProviders: diffRecord,
    optimizerRules: optimizerRecord,
    aliases,
    dslEnvironment,
  });
};
