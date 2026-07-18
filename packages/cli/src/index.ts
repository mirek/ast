import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DslError,
  PluginError,
  adapterCompatibility,
  applyChangePlan,
  compileDsl,
  createFilesystemAdapter,
  createJsonAdapter,
  createMarkdownAdapter,
  createTypeScriptAdapter,
  deserializeChangePlan,
  filesystemWrite,
  fromAdapter,
  fromFilesystem,
  jsonInsertArrayItem,
  jsonInsertProperty,
  jsonRemoveArrayItem,
  jsonRemoveProperty,
  jsonReplaceValue,
  markdownReplaceSection,
  markdownSetHeading,
  mountJson,
  mountMarkdown,
  mountTypeScript,
  renderChangePlan,
  registerPlugins,
  serializeChangePlan,
  typeScriptRenameSymbol,
  typeScriptReplaceCall,
} from "@mirek/ast";
import type {
  Adapter,
  ChangePlan,
  Diagnostic,
  DslEnvironment,
  JsonValue,
  NodeSnapshot,
  PluginAliases,
  PluginModule,
  PluginPower,
  PluginRegistry,
} from "@mirek/ast";

export interface CliIo {
  readonly stdout: { write(value: string): unknown };
  readonly stderr: { write(value: string): unknown };
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

export const EXIT = Object.freeze({
  success: 0,
  usage: 1,
  diagnostic: 2,
  invalidPlan: 3,
  confirmation: 4,
  apply: 5,
  cancelled: 130,
});

interface ParsedArguments {
  readonly command: string;
  readonly positional: readonly string[];
  readonly format?: "jsonl" | "pretty";
  readonly color?: "auto" | "always" | "never";
  readonly config?: string;
  readonly save?: string;
  readonly yes: boolean;
  readonly allowDestructive: boolean;
  readonly allowIrreversible: boolean;
}

interface CliConfig {
  readonly format?: "jsonl" | "pretty";
  readonly color?: "auto" | "always" | "never";
  readonly plugins?: readonly CliPluginConfig[];
}

interface CliPluginConfig {
  readonly specifier: string;
  readonly name: string;
  readonly powers?: readonly PluginPower[];
  readonly aliases?: PluginAliases;
}

interface ResolvedCliConfig {
  readonly format: "jsonl" | "pretty";
  readonly color: "auto" | "always" | "never";
  readonly plugins: readonly CliPluginConfig[];
}

const usage = "Usage: ast <query|plan|apply|explain|schema|plugins> [program-or-name] [options]\n";

const parseArguments = (args: readonly string[]): ParsedArguments => {
  const command = args[0] ?? "";
  const positional: string[] = [];
  let format: ParsedArguments["format"];
  let color: ParsedArguments["color"];
  let config: string | undefined;
  let save: string | undefined;
  let yes = false;
  let allowDestructive = false;
  let allowIrreversible = false;
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (value === "--yes") yes = true;
    else if (value === "--allow-destructive") allowDestructive = true;
    else if (value === "--allow-irreversible") allowIrreversible = true;
    else if (["--format", "--color", "--config", "--save"].includes(value)) {
      const next = args[index + 1];
      if (next === undefined) throw new TypeError(`${value} requires a value.`);
      index += 1;
      if (value === "--format") {
        if (next !== "jsonl" && next !== "pretty") throw new TypeError("Format must be jsonl or pretty.");
        format = next;
      } else if (value === "--color") {
        if (next !== "auto" && next !== "always" && next !== "never") throw new TypeError("Color must be auto, always, or never.");
        color = next;
      } else if (value === "--config") config = next;
      else save = next;
    } else if (value.startsWith("--")) throw new TypeError(`Unknown option ${value}.`);
    else positional.push(value);
  }
  return { command, positional, ...(format === undefined ? {} : { format }), ...(color === undefined ? {} : { color }), ...(config === undefined ? {} : { config }), ...(save === undefined ? {} : { save }), yes, allowDestructive, allowIrreversible };
};

const loadConfig = async (parsed: ParsedArguments, io: CliIo): Promise<ResolvedCliConfig> => {
  const path = resolve(io.cwd, parsed.config ?? ".astrc.json");
  let file: CliConfig = {};
  try {
    file = JSON.parse(await readFile(path, "utf8")) as CliConfig;
  } catch (error) {
    if (parsed.config !== undefined || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const environmentFormat = io.env.AST_FORMAT;
  const environmentColor = io.env.NO_COLOR !== undefined ? "never" : io.env.AST_COLOR;
  const format = parsed.format ?? (environmentFormat === "jsonl" || environmentFormat === "pretty" ? environmentFormat : undefined) ?? file.format ?? (io.stdoutIsTTY ? "pretty" : "jsonl");
  const color = parsed.color ?? (environmentColor === "auto" || environmentColor === "always" || environmentColor === "never" ? environmentColor : undefined) ?? file.color ?? "auto";
  if (file.plugins !== undefined && !Array.isArray(file.plugins)) throw new TypeError("CLI plugins configuration must be an array.");
  return { format, color, plugins: file.plugins ?? [] };
};

const secret = /(?:password|passwd|secret|token|credential|api[-_]?key)/iu;
const serializable = (value: unknown, key = ""): unknown => {
  if (secret.test(key)) return "[REDACTED]";
  if (typeof value === "bigint") return `${value}n`;
  if (value !== null && typeof value === "object" && "snapshot" in value) return serializable((value as { readonly snapshot: NodeSnapshot }).snapshot);
  if (Array.isArray(value)) return value.map((item) => serializable(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([name, item]) => [name, serializable(item, name)]));
  }
  return value;
};

const line = (value: unknown): string => `${JSON.stringify(serializable(value))}\n`;
const emit = (io: CliIo, format: "jsonl" | "pretty", value: unknown, type = "data"): void => {
  if (format === "jsonl") io.stdout.write(line({ type, value }));
  else io.stdout.write(`${JSON.stringify(serializable(value), undefined, 2)}\n`);
};
const emitDiagnostic = (io: CliIo, value: Diagnostic): void => { io.stderr.write(line({ type: "diagnostic", value })); };

const mergeAliases = (entries: readonly CliPluginConfig[]): PluginAliases => {
  const categories = ["namespaces", "sources", "mounts", "operations", "predicates", "functions", "renderers", "diffProviders"] as const;
  const merged: Record<string, Record<string, string>> = Object.create(null) as Record<string, Record<string, string>>;
  for (const category of categories) {
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const entry of entries) for (const [alias, target] of Object.entries(entry.aliases?.[category] ?? {})) {
      if (values[alias] !== undefined) throw new PluginError("plugin.duplicate-alias", `Plugin alias ${alias} is configured more than once for ${category}.`);
      values[alias] = target;
    }
    merged[category] = values;
  }
  return merged as PluginAliases;
};

const loadPlugins = async (
  entries: readonly CliPluginConfig[],
  cwd: string,
  reservedNamespaces: readonly string[],
): Promise<PluginRegistry> => {
  const modules: PluginModule[] = [];
  for (const entry of entries) {
    if (typeof entry.specifier !== "string" || entry.specifier.length === 0 || typeof entry.name !== "string" || entry.name.length === 0) {
      throw new PluginError("plugin.invalid-config", "Every configured plugin requires a specifier and expected package name.");
    }
    const specifier = isAbsolute(entry.specifier) || entry.specifier.startsWith(".")
      ? pathToFileURL(resolve(cwd, entry.specifier)).href
      : entry.specifier;
    let loaded: { readonly default?: unknown; readonly plugin?: unknown };
    try {
      // Importing executes trusted JavaScript. Policy validation happens before any contribution is used.
      // oxlint-disable-next-line no-await-in-loop
      loaded = await import(specifier) as { readonly default?: unknown; readonly plugin?: unknown };
    } catch (error) {
      throw new PluginError("plugin.load-failed", `Could not load configured plugin ${entry.name}.`, { cause: error });
    }
    const candidate = loaded.default ?? loaded.plugin;
    if (candidate === null || typeof candidate !== "object") throw new PluginError("plugin.invalid-module", `Plugin module ${entry.specifier} does not export a plugin object.`);
    modules.push(candidate as PluginModule);
  }
  return registerPlugins(modules, {
    allow: entries.map(({ name }) => name),
    powers: Object.fromEntries(entries.map(({ name, powers }) => [name, powers ?? []])),
    aliases: mergeAliases(entries),
    reservedNamespaces,
  });
};

const mergeEnvironment = <T>(label: string, builtIn: Readonly<Record<string, T>>, plugin: Readonly<Record<string, T>>): Readonly<Record<string, T>> => {
  for (const name of Object.keys(plugin)) if (builtIn[name] !== undefined) throw new PluginError("plugin.duplicate-alias", `Plugin ${label} alias ${name} conflicts with a built-in.`);
  return Object.freeze({ ...builtIn, ...plugin });
};

const createRuntime = async (config: ResolvedCliConfig, cwd: string) => {
  const filesystem = createFilesystemAdapter();
  const json = createJsonAdapter();
  const markdown = createMarkdownAdapter({ json });
  const typescript = createTypeScriptAdapter();
  const builtInAdapters: readonly Adapter[] = [filesystem, json, markdown, typescript];
  const plugins = await loadPlugins(config.plugins, cwd, builtInAdapters.map(({ namespace }) => namespace));
  const adapters: readonly Adapter[] = Object.freeze([...builtInAdapters, ...plugins.adapters]);
  const builtInSources: DslEnvironment["sources"] = {
    fs: { adapter: filesystem, selectorSource: "selection", open: (args) => fromFilesystem(filesystem, { uri: String(args[0] ?? ".") }) },
    json: { adapter: json, selectorSource: "roots", open: (args) => fromAdapter(json, { uri: String(args[0] ?? "") }) },
    markdown: { adapter: markdown, selectorSource: "roots", open: (args) => fromAdapter(markdown, { uri: String(args[0] ?? "") }) },
    ts: { adapter: typescript, selectorSource: "roots", open: (args) => fromAdapter(typescript, { uri: String(args[0] ?? "") }) },
  };
  const builtInMounts: NonNullable<DslEnvironment["mounts"]> = {
    json: { adapter: json, mount: (query) => mountJson(query, json) },
    markdown: { adapter: markdown, mount: (query) => mountMarkdown(query, markdown) },
    ts: { adapter: typescript, mount: (query) => mountTypeScript(query, typescript) },
  };
  const builtInOperations: NonNullable<DslEnvironment["operations"]> = {
    "fs::write": { adapter: filesystem, create: (target, args) => filesystemWrite(target.snapshot, { encoding: "utf8", content: String(args.content ?? "") }) },
    "json::replace-value": { adapter: json, create: (target, args) => jsonReplaceValue(target.snapshot, args.value as JsonValue) },
    "json::insert-property": { adapter: json, create: (target, args) => jsonInsertProperty(target.snapshot, String(args.name ?? ""), args.value as JsonValue) },
    "json::remove-property": { adapter: json, create: (target) => jsonRemoveProperty(target.snapshot) },
    "json::insert-array-item": { adapter: json, create: (target, args) => jsonInsertArrayItem(target.snapshot, Number(args.index), args.value as JsonValue) },
    "json::remove-array-item": { adapter: json, create: (target) => jsonRemoveArrayItem(target.snapshot) },
    "markdown::set-heading": { adapter: markdown, create: (target, args) => markdownSetHeading(target.snapshot, String(args.title ?? "")) },
    "markdown::replace-section": { adapter: markdown, create: (target, args) => markdownReplaceSection(target.snapshot, String(args.content ?? "")) },
    "ts::rename-symbol": { adapter: typescript, create: (target, args) => typeScriptRenameSymbol(target.snapshot, String(args.name ?? "")) },
    "ts::replace-call": { adapter: typescript, create: (target, args) => typeScriptReplaceCall(target.snapshot, String(args.callee ?? "")) },
  };
  const environment: DslEnvironment = {
    sources: mergeEnvironment("source", builtInSources, plugins.dslEnvironment.sources),
    mounts: mergeEnvironment("mount", builtInMounts, plugins.dslEnvironment.mounts ?? {}),
    operations: mergeEnvironment("operation", builtInOperations, plugins.dslEnvironment.operations ?? {}),
  };
  const schemas = Object.freeze(Object.fromEntries([
    ...builtInAdapters.map((adapter) => [adapter.namespace, adapter.schema] as const),
    ...Object.entries(plugins.schemas),
  ]));
  return { adapters, environment, plugins, schemas };
};

const inputText = async (value: string, cwd: string): Promise<string> => {
  try { return await readFile(resolve(cwd, value), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return value; throw error; }
};

const diagnosticsOf = (adapters: readonly Adapter[]): readonly Diagnostic[] => adapters.flatMap((adapter) => adapter.diagnostics?.() ?? []);

export const runCli = async (args: readonly string[], io: CliIo): Promise<number> => {
  try {
    const parsed = parseArguments(args);
    if (!["query", "plan", "apply", "explain", "schema", "plugins"].includes(parsed.command)) { io.stderr.write(usage); return EXIT.usage; }
    const config = await loadConfig(parsed, io);
    const runtime = await createRuntime(config, io.cwd);
    if (parsed.command === "schema") {
      const requested = parsed.positional[0];
      const namespace = requested === undefined ? undefined : runtime.plugins.aliases.namespaces[requested] ?? requested;
      const schema = namespace === undefined ? undefined : runtime.schemas[namespace];
      if (schema === undefined) throw new TypeError(`Unknown adapter namespace ${JSON.stringify(requested)}.`);
      io.stdout.write(`${JSON.stringify(serializable(schema), undefined, config.format === "pretty" ? 2 : undefined)}\n`);
      return EXIT.success;
    }
    if (parsed.command === "plugins") {
      const values = runtime.adapters.map((adapter) => adapter.plugin === undefined
        ? { ...adapterCompatibility(adapter), builtIn: true }
        : { ...adapterCompatibility(adapter), builtIn: false, plugin: adapter.plugin, trustedCode: true, isolated: false });
      io.stdout.write(`${JSON.stringify(values, undefined, config.format === "pretty" ? 2 : undefined)}\n`);
      return EXIT.success;
    }
    const input = parsed.positional[0];
    if (input === undefined) { io.stderr.write(usage); return EXIT.usage; }
    const text = await inputText(input, io.cwd);
    let savedPlan: ChangePlan | undefined;
    if (parsed.command === "apply") {
      let envelope = false;
      try {
        const parsedInput = JSON.parse(text) as { readonly integrity?: unknown; readonly plan?: unknown };
        envelope = typeof parsedInput.integrity === "string" && parsedInput.plan !== undefined;
      } catch { /* Non-JSON input is treated as DSL. */ }
      if (envelope) {
        try {
          savedPlan = deserializeChangePlan(text, { adapters: runtime.adapters });
        } catch (error) {
          io.stderr.write(line({ type: "diagnostic", value: { code: "cli.invalid-plan", severity: "error", message: error instanceof Error ? error.message : "Invalid saved plan." } }));
          return EXIT.invalidPlan;
        }
      }
    }
    const compiled = savedPlan === undefined ? compileDsl(text, runtime.environment, { uri: resolve(io.cwd, input) }) : undefined;
    if (parsed.command === "query") {
      if (compiled?.kind !== "query") throw new TypeError("query requires a query program.");
      for await (const value of compiled.query.iterate(io.signal === undefined ? {} : { signal: io.signal })) emit(io, config.format, value);
      const diagnostics = diagnosticsOf(runtime.adapters);
      for (const diagnostic of diagnostics) emitDiagnostic(io, diagnostic);
      return diagnostics.some(({ severity }) => severity === "error")
        ? EXIT.diagnostic
        : EXIT.success;
    }
    if (parsed.command === "explain") {
      if (compiled?.kind === "query") io.stdout.write(`${JSON.stringify(serializable(compiled.query.explain()), undefined, 2)}\n`);
      else if (compiled?.kind === "plan") {
        const plan = await compiled.plan();
        io.stdout.write(`${JSON.stringify(serializable({ changes: plan.changes.map(({ id, risk, summary }) => ({ id, risk, summary })), diagnostics: plan.diagnostics, transactionGroups: plan.transactionGroups }), undefined, 2)}\n`);
      } else throw new TypeError("explain requires a DSL program.");
      return EXIT.success;
    }
    let plan = savedPlan;
    if (plan === undefined) {
      if (compiled?.kind !== "plan") throw new TypeError(`${parsed.command} requires a transformation program or saved plan.`);
      plan = await compiled.plan();
    }
    if (plan.diagnostics.some(({ severity }) => severity === "error")) {
      for (const diagnostic of plan.diagnostics) emitDiagnostic(io, diagnostic);
      return EXIT.invalidPlan;
    }
    if (parsed.command === "plan") {
      io.stdout.write(renderChangePlan(plan));
      if (parsed.save !== undefined) await writeFile(resolve(io.cwd, parsed.save), serializeChangePlan(plan), "utf8");
      return EXIT.success;
    }
    if (!parsed.yes) { io.stderr.write("Apply requires --yes; non-interactive execution never prompts.\n"); return EXIT.confirmation; }
    if (plan.changes.some(({ risk }) => risk === "destructive") && !parsed.allowDestructive) { io.stderr.write("Destructive changes require --allow-destructive.\n"); return EXIT.confirmation; }
    if (plan.changes.some(({ risk }) => risk === "irreversible") && !parsed.allowIrreversible) { io.stderr.write("Irreversible changes require --allow-irreversible.\n"); return EXIT.confirmation; }
    const result = await applyChangePlan(
      plan,
      runtime.adapters,
      io.signal === undefined ? {} : { signal: io.signal },
    );
    emit(io, config.format, result, "apply");
    return result.groups.some(({ status }) => status === "failed") ? EXIT.apply : EXIT.success;
  } catch (error) {
    if (io.signal?.aborted === true || (error instanceof Error && error.name === "AbortError")) return EXIT.cancelled;
    if (error instanceof DslError) for (const value of error.diagnostics) emitDiagnostic(io, value);
    else if (error instanceof PluginError) io.stderr.write(line({ type: "diagnostic", value: { code: error.code, severity: "error", message: error.message } }));
    else io.stderr.write(line({ type: "diagnostic", value: { code: "cli.error", severity: "error", message: error instanceof Error ? error.message : "Unknown CLI failure." } }));
    return EXIT.diagnostic;
  }
};
