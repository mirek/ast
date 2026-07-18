import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
  FilesystemNodeKind,
  FilesystemSource,
  JsonValue,
  NodeSnapshot,
  PluginAliases,
  PluginModule,
  PluginDiffProviderContribution,
  PluginPower,
  PluginRegistry,
  PluginRendererContribution,
} from "@mirek/ast";

export interface CliIo {
  readonly stdout: { write(value: string): unknown };
  readonly stderr: { write(value: string): unknown };
  readonly stdin?: AsyncIterable<string | Uint8Array>;
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
  readonly options: readonly string[];
  readonly help: boolean;
  readonly file?: string;
  readonly expression?: string;
  readonly stdin: boolean;
  readonly format?: "jsonl" | "pretty";
  readonly color?: "auto" | "always" | "never";
  readonly config?: string;
  readonly save?: string;
  readonly renderer?: string;
  readonly diffProvider?: string;
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

class CliUsageError extends TypeError {
  readonly code = "cli.usage";
  override readonly name = "CliUsageError";
}

class CliConfigError extends TypeError {
  readonly code = "cli.invalid-config";
  override readonly name = "CliConfigError";
}

const version = (createRequire(import.meta.url)("../package.json") as { readonly version: string }).version;
const commands = ["query", "plan", "apply", "explain", "schema", "plugins"] as const;
type CliCommand = typeof commands[number];

const usage = [
  "Usage: ast <query|plan|apply|explain> (--file <path> | --expr <program> | --stdin) [options]",
  "       ast <query|plan|apply|explain> <file-path|-> [options]",
  "       ast schema <namespace> [options]",
  "       ast plugins [options]",
  "",
  "Commands:",
  "  query     Stream query results.",
  "  plan      Preview a transformation plan.",
  "  apply     Apply a transformation or saved plan.",
  "  explain   Explain a query or transformation.",
  "  schema    Print one adapter schema.",
  "  plugins   Print the admitted adapter inventory.",
  "",
  "Global options:",
  "  --format <jsonl|pretty>   Select output formatting.",
  "  --color <auto|always|never> Select color policy.",
  "  --config <path>          Read configuration from a specific file.",
  "  -h, --help               Show help.",
  "  -V, --version            Show the CLI version.",
  "",
  "Run ast <command> --help for command-specific options.",
].join("\n");

const inputHelp = [
  "  --file <path>            Read input from a file.",
  "  --expr <program>         Read an inline DSL program.",
  "  --stdin                  Read input from standard input.",
];
const rendererHelp = "  --renderer <name>         Select a plugin renderer for terminal query output.";
const diffProviderHelp = "  --diff-provider <name>    Select a plugin diff provider for terminal plans.";
const commonHelp = [
  "  --format <jsonl|pretty>  Select output formatting.",
  "  --color <auto|always|never> Select color policy.",
  "  --config <path>          Read configuration from a specific file.",
  "  -h, --help               Show this help.",
];
const commandHelp: Readonly<Record<CliCommand, string>> = Object.freeze({
  query: ["Usage: ast query <input> [options]", "", "Input options:", ...inputHelp, "", "Options:", rendererHelp, ...commonHelp, ""].join("\n"),
  plan: ["Usage: ast plan <input> [--save <path>] [options]", "", "Input options:", ...inputHelp, "", "Options:", "  --save <path>            Save the plan envelope.", diffProviderHelp, ...commonHelp, ""].join("\n"),
  apply: ["Usage: ast apply <input> --yes [risk acknowledgements] [options]", "", "Input options:", ...inputHelp, "", "Options:", "  --yes                    Confirm non-interactive application.", "  --allow-destructive      Acknowledge destructive changes.", "  --allow-irreversible     Acknowledge irreversible changes.", ...commonHelp, ""].join("\n"),
  explain: ["Usage: ast explain <input> [options]", "", "Input options:", ...inputHelp, "", "Options:", ...commonHelp, ""].join("\n"),
  schema: ["Usage: ast schema <namespace> [options]", "", "Options:", ...commonHelp, ""].join("\n"),
  plugins: ["Usage: ast plugins [options]", "", "Options:", ...commonHelp, ""].join("\n"),
});

const isCommand = (value: string): value is CliCommand => (commands as readonly string[]).includes(value);

const parseArguments = (args: readonly string[]): ParsedArguments => {
  const command = args[0] ?? "";
  const positional: string[] = [];
  const options: string[] = [];
  const seen = new Set<string>();
  let help = false;
  let format: ParsedArguments["format"];
  let color: ParsedArguments["color"];
  let config: string | undefined;
  let save: string | undefined;
  let renderer: string | undefined;
  let diffProvider: string | undefined;
  let file: string | undefined;
  let expression: string | undefined;
  let stdin = false;
  let yes = false;
  let allowDestructive = false;
  let allowIrreversible = false;
  const use = (option: string): void => {
    if (seen.has(option)) throw new CliUsageError(`${option} may be specified only once.`);
    seen.add(option);
    options.push(option);
  };
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (value === "--help" || value === "-h") {
      use("--help");
      help = true;
    }
    else if (value === "--yes") { use(value); yes = true; }
    else if (value === "--stdin") {
      use(value);
      stdin = true;
    }
    else if (value === "--allow-destructive") { use(value); allowDestructive = true; }
    else if (value === "--allow-irreversible") { use(value); allowIrreversible = true; }
    else if (["--format", "--color", "--config", "--save", "--file", "--expr", "--renderer", "--diff-provider"].includes(value)) {
      const next = args[index + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) throw new CliUsageError(`${value} requires a value.`);
      use(value);
      index += 1;
      if (value === "--format") {
        if (next !== "jsonl" && next !== "pretty") throw new CliUsageError("Format must be jsonl or pretty.");
        format = next;
      } else if (value === "--color") {
        if (next !== "auto" && next !== "always" && next !== "never") throw new CliUsageError("Color must be auto, always, or never.");
        color = next;
      } else if (value === "--config") config = next;
      else if (value === "--save") save = next;
      else if (value === "--renderer") renderer = next;
      else if (value === "--diff-provider") diffProvider = next;
      else if (value === "--file") file = next;
      else expression = next;
    } else if (value.startsWith("-") && value !== "-") throw new CliUsageError(`Unknown option ${value}.`);
    else positional.push(value);
  }
  return {
    command,
    positional: Object.freeze(positional),
    options: Object.freeze(options),
    help,
    ...(file === undefined ? {} : { file }),
    ...(expression === undefined ? {} : { expression }),
    stdin,
    ...(format === undefined ? {} : { format }),
    ...(color === undefined ? {} : { color }),
    ...(config === undefined ? {} : { config }),
    ...(save === undefined ? {} : { save }),
    ...(renderer === undefined ? {} : { renderer }),
    ...(diffProvider === undefined ? {} : { diffProvider }),
    yes,
    allowDestructive,
    allowIrreversible,
  };
};

const commonOptions = ["--format", "--color", "--config", "--help"] as const;
const inputOptions = ["--file", "--expr", "--stdin"] as const;
const allowedOptions: Readonly<Record<CliCommand, readonly string[]>> = Object.freeze({
  query: [...commonOptions, ...inputOptions, "--renderer"],
  plan: [...commonOptions, ...inputOptions, "--save", "--diff-provider"],
  apply: [...commonOptions, ...inputOptions, "--yes", "--allow-destructive", "--allow-irreversible"],
  explain: [...commonOptions, ...inputOptions],
  schema: commonOptions,
  plugins: commonOptions,
});

const validateArguments = (parsed: ParsedArguments): CliCommand => {
  if (!isCommand(parsed.command)) throw new CliUsageError(`Unknown command ${JSON.stringify(parsed.command)}.`);
  const command = parsed.command;
  for (const option of parsed.options) {
    if (!allowedOptions[command].includes(option)) throw new CliUsageError(`${option} is not valid for ast ${command}.`);
  }
  if (parsed.help) return command;
  if (["query", "plan", "apply", "explain"].includes(command)) {
    if (parsed.positional.length > 1) throw new CliUsageError(`${command} accepts at most one positional file path.`);
    const inputCount = Number(parsed.file !== undefined)
      + Number(parsed.expression !== undefined)
      + Number(parsed.stdin)
      + parsed.positional.length;
    if (inputCount !== 1) throw new CliUsageError(`${command} requires exactly one input mode.`);
  } else if (command === "schema" && parsed.positional.length !== 1) {
    throw new CliUsageError("schema requires exactly one namespace.");
  } else if (command === "plugins" && parsed.positional.length !== 0) {
    throw new CliUsageError("plugins does not accept positional arguments.");
  }
  return command;
};

const aliasCategories = ["namespaces", "sources", "mounts", "operations", "predicates", "functions", "renderers", "diffProviders"] as const;
const pluginPowers = new Set<PluginPower>([
  "resource:read", "resource:write", "filesystem:read", "filesystem:write",
  "network:read", "network:write", "process:execute", "credentials:read",
  "native-modules:load",
]);

const configRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CliConfigError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const validateKeys = (value: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new CliConfigError(`${label} contains unknown field ${JSON.stringify(unknown[0])}.`);
};

const configString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new CliConfigError(`${label} must be a non-empty string.`);
  return value;
};

const validateAliases = (value: unknown, label: string): PluginAliases => {
  const aliases = configRecord(value, label);
  validateKeys(aliases, aliasCategories, label);
  const result: Record<string, Readonly<Record<string, string>>> = Object.create(null) as Record<string, Readonly<Record<string, string>>>;
  for (const category of aliasCategories) {
    if (aliases[category] === undefined) continue;
    const configured = configRecord(aliases[category], `${label}.${category}`);
    const entries: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [alias, target] of Object.entries(configured)) {
      if (alias.length === 0) throw new CliConfigError(`${label}.${category} contains an empty alias.`);
      entries[alias] = configString(target, `${label}.${category}.${alias}`);
    }
    result[category] = Object.freeze(entries);
  }
  return Object.freeze(result) as PluginAliases;
};

const validatePluginConfig = (value: unknown, index: number): CliPluginConfig => {
  const label = `CLI config plugins[${index}]`;
  const plugin = configRecord(value, label);
  validateKeys(plugin, ["specifier", "name", "powers", "aliases"], label);
  const specifier = configString(plugin.specifier, `${label}.specifier`);
  const name = configString(plugin.name, `${label}.name`);
  let powers: readonly PluginPower[] | undefined;
  if (plugin.powers !== undefined) {
    if (!Array.isArray(plugin.powers)) throw new CliConfigError(`${label}.powers must be an array.`);
    const validated: PluginPower[] = [];
    for (const [powerIndex, power] of plugin.powers.entries()) {
      if (typeof power !== "string" || !pluginPowers.has(power as PluginPower)) {
        throw new CliConfigError(`${label}.powers[${powerIndex}] is not a supported plugin power.`);
      }
      if (validated.includes(power as PluginPower)) throw new CliConfigError(`${label}.powers contains duplicate ${JSON.stringify(power)}.`);
      validated.push(power as PluginPower);
    }
    powers = Object.freeze(validated);
  }
  const aliases = plugin.aliases === undefined ? undefined : validateAliases(plugin.aliases, `${label}.aliases`);
  return Object.freeze({
    specifier,
    name,
    ...(powers === undefined ? {} : { powers }),
    ...(aliases === undefined ? {} : { aliases }),
  });
};

const validateCliConfig = (value: unknown): CliConfig => {
  const config = configRecord(value, "CLI config");
  validateKeys(config, ["format", "color", "plugins"], "CLI config");
  if (config.format !== undefined && config.format !== "jsonl" && config.format !== "pretty") {
    throw new CliConfigError("CLI config format must be jsonl or pretty.");
  }
  if (config.color !== undefined && config.color !== "auto" && config.color !== "always" && config.color !== "never") {
    throw new CliConfigError("CLI config color must be auto, always, or never.");
  }
  let plugins: readonly CliPluginConfig[] | undefined;
  if (config.plugins !== undefined) {
    if (!Array.isArray(config.plugins)) throw new CliConfigError("CLI config plugins must be an array.");
    plugins = Object.freeze(config.plugins.map(validatePluginConfig));
    const names = new Set<string>();
    const specifiers = new Set<string>();
    const aliases = Object.fromEntries(aliasCategories.map((category) => [category, new Set<string>()])) as Record<typeof aliasCategories[number], Set<string>>;
    for (const plugin of plugins) {
      if (names.has(plugin.name)) throw new CliConfigError(`CLI config contains duplicate plugin name ${JSON.stringify(plugin.name)}.`);
      if (specifiers.has(plugin.specifier)) throw new CliConfigError(`CLI config contains duplicate plugin specifier ${JSON.stringify(plugin.specifier)}.`);
      names.add(plugin.name);
      specifiers.add(plugin.specifier);
      for (const category of aliasCategories) for (const alias of Object.keys(plugin.aliases?.[category] ?? {})) {
        if (aliases[category].has(alias)) throw new CliConfigError(`CLI config contains duplicate ${category} alias ${JSON.stringify(alias)}.`);
        aliases[category].add(alias);
      }
    }
  }
  return Object.freeze({
    ...(config.format === undefined ? {} : { format: config.format }),
    ...(config.color === undefined ? {} : { color: config.color }),
    ...(plugins === undefined ? {} : { plugins }),
  }) as CliConfig;
};

const loadConfig = async (parsed: ParsedArguments, io: CliIo): Promise<ResolvedCliConfig> => {
  const path = resolve(io.cwd, parsed.config ?? ".astrc.json");
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (parsed.config === undefined && (error as NodeJS.ErrnoException).code === "ENOENT") raw = {};
    else throw new CliConfigError(`Could not load CLI config ${JSON.stringify(path)}.`);
  }
  const file = validateCliConfig(raw);
  const environmentFormat = io.env.AST_FORMAT;
  if (environmentFormat !== undefined && environmentFormat !== "jsonl" && environmentFormat !== "pretty") {
    throw new CliConfigError("AST_FORMAT must be jsonl or pretty.");
  }
  const configuredEnvironmentColor = io.env.AST_COLOR;
  if (configuredEnvironmentColor !== undefined && configuredEnvironmentColor !== "auto" && configuredEnvironmentColor !== "always" && configuredEnvironmentColor !== "never") {
    throw new CliConfigError("AST_COLOR must be auto, always, or never.");
  }
  const environmentColor = io.env.NO_COLOR !== undefined ? "never" : configuredEnvironmentColor;
  const format = parsed.format ?? environmentFormat ?? file.format ?? (io.stdoutIsTTY ? "pretty" : "jsonl");
  const color = parsed.color ?? environmentColor ?? file.color ?? "auto";
  return Object.freeze({ format, color, plugins: file.plugins ?? Object.freeze([]) });
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

const selectPresentation = <Contribution>(
  requested: string | undefined,
  aliases: Readonly<Record<string, string>>,
  contributions: Readonly<Record<string, Contribution>>,
  label: string,
): Contribution | undefined => {
  if (requested === undefined) return undefined;
  const canonical = aliases[requested] ?? requested;
  const contribution = contributions[canonical];
  if (contribution === undefined) throw new PluginError("plugin.unknown-presentation", `Unknown plugin ${label} ${JSON.stringify(requested)}.`);
  return contribution;
};

const presentationFailure = (label: string, error: unknown): never => {
  throw new PluginError("plugin.presentation-failed", `Plugin ${label} failed without a presentation fallback.`, { cause: error });
};

const renderPluginValue = (renderer: PluginRendererContribution, value: unknown): string => {
  try {
    const rendered = renderer.render(serializable(value));
    if (typeof rendered !== "string") throw new TypeError("Plugin renderer must return a string.");
    return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  } catch (error) {
    return presentationFailure(`renderer ${renderer.name}`, error);
  }
};

const renderPluginPlan = (plan: ChangePlan, provider: PluginDiffProviderContribution): string => {
  const lines: string[] = [];
  for (const change of plan.changes) {
    lines.push(`[${change.risk.toUpperCase()}] ${change.summary}`);
    if (change.preview === undefined) continue;
    const before = change.preview.sensitive ? "[REDACTED]" : change.preview.before;
    const after = change.preview.sensitive ? "[REDACTED]" : change.preview.after;
    try {
      const rendered = provider.render(before, after);
      if (typeof rendered !== "string") throw new TypeError("Plugin diff provider must return a string.");
      lines.push(rendered);
    } catch (error) {
      return presentationFailure(`diff provider ${provider.name}`, error);
    }
  }
  for (const diagnostic of plan.diagnostics) {
    lines.push(`[${diagnostic.severity.toUpperCase()} ${diagnostic.code}] ${diagnostic.message}`);
  }
  return `${lines.join("\n")}\n`;
};

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
    fs: {
      adapter: filesystem,
      selectorSource: "selection",
      arguments: {
        uri: { type: "string", cardinality: "one", required: false, default: "." },
        include: { type: "string", cardinality: "many", required: false },
        exclude: { type: "string", cardinality: "many", required: false },
        kinds: {
          type: "string",
          cardinality: "many",
          required: false,
          choices: ["fs::directory", "fs::file", "fs::symlink"],
        },
        minSize: { type: "number", cardinality: "one", required: false },
        maxSize: { type: "number", cardinality: "one", required: false },
        modifiedAfter: { type: "number", cardinality: "one", required: false },
        modifiedBefore: { type: "number", cardinality: "one", required: false },
      },
      open: (args) => {
        const source: FilesystemSource = {
          uri: args.uri as string,
          ...(args.include === undefined ? {} : { include: args.include as readonly string[] }),
          ...(args.exclude === undefined ? {} : { exclude: args.exclude as readonly string[] }),
          ...(args.kinds === undefined ? {} : { kinds: args.kinds as readonly FilesystemNodeKind[] }),
          ...(args.minSize === undefined ? {} : { minSize: args.minSize as number }),
          ...(args.maxSize === undefined ? {} : { maxSize: args.maxSize as number }),
          ...(args.modifiedAfter === undefined ? {} : { modifiedAfter: args.modifiedAfter as number }),
          ...(args.modifiedBefore === undefined ? {} : { modifiedBefore: args.modifiedBefore as number }),
        };
        return fromFilesystem(filesystem, source);
      },
    },
    json: {
      adapter: json,
      selectorSource: "roots",
      arguments: { uri: { type: "string", cardinality: "one", required: true } },
      open: (args) => fromAdapter(json, { uri: args.uri as string }),
    },
    markdown: {
      adapter: markdown,
      selectorSource: "roots",
      arguments: { uri: { type: "string", cardinality: "one", required: true } },
      open: (args) => fromAdapter(markdown, { uri: args.uri as string }),
    },
    ts: {
      adapter: typescript,
      selectorSource: "roots",
      arguments: { uri: { type: "string", cardinality: "one", required: true } },
      open: (args) => fromAdapter(typescript, { uri: args.uri as string }),
    },
  };
  const builtInMounts: NonNullable<DslEnvironment["mounts"]> = {
    json: {
      adapter: json,
      arguments: {
        onError: {
          type: "string",
          cardinality: "one",
          required: false,
          default: "skip",
          choices: ["skip", "throw"],
        },
      },
      mount: (query, args) => mountJson(query, json, {
        onError: args.onError as "skip" | "throw",
      }),
    },
    markdown: {
      adapter: markdown,
      arguments: {},
      mount: (query) => mountMarkdown(query, markdown),
    },
    ts: {
      adapter: typescript,
      arguments: {},
      mount: (query) => mountTypeScript(query, typescript),
    },
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

type CliInput =
  | { readonly kind: "file"; readonly value: string; readonly uri: string }
  | { readonly kind: "expression"; readonly value: string; readonly uri: "argv:program" }
  | { readonly kind: "stdin"; readonly uri: "stdin:program" };

const resolveInput = (parsed: ParsedArguments, cwd: string): CliInput => {
  if (parsed.positional.length > 1) {
    throw new CliUsageError("Input commands accept at most one positional file path.");
  }
  const inputs: CliInput[] = [];
  if (parsed.file !== undefined) {
    const path = resolve(cwd, parsed.file);
    inputs.push({ kind: "file", value: path, uri: path });
  }
  if (parsed.expression !== undefined) {
    inputs.push({ kind: "expression", value: parsed.expression, uri: "argv:program" });
  }
  if (parsed.stdin) inputs.push({ kind: "stdin", uri: "stdin:program" });
  const positional = parsed.positional[0];
  if (positional === "-") inputs.push({ kind: "stdin", uri: "stdin:program" });
  else if (positional !== undefined) {
    const path = resolve(cwd, positional);
    inputs.push({ kind: "file", value: path, uri: path });
  }
  const input = inputs[0];
  if (inputs.length !== 1 || input === undefined) {
    throw new CliUsageError(
      "Input commands require exactly one input mode: --file, --expr, --stdin, a file path, or -.",
    );
  }
  return input;
};

const nextWithSignal = <Value>(
  iterator: AsyncIterator<Value>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<Value>> => {
  if (signal === undefined) return iterator.next();
  signal.throwIfAborted();
  return new Promise((resolveNext, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", aborted);
    const aborted = (): void => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error("Input cancelled."));
    };
    signal.addEventListener("abort", aborted, { once: true });
    iterator.next().then(
      (value) => { cleanup(); resolveNext(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
};

const stdinText = async (
  stdin: AsyncIterable<string | Uint8Array> | undefined,
  signal: AbortSignal | undefined,
): Promise<string> => {
  if (stdin === undefined) throw new CliUsageError("Standard input is unavailable.");
  const iterator = stdin[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  let result = "";
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- stdin must be decoded in stream order.
      const next = await nextWithSignal(iterator, signal);
      if (next.done) break;
      result += typeof next.value === "string"
        ? next.value
        : decoder.decode(next.value, { stream: true });
    }
    return result + decoder.decode();
  } finally {
    await iterator.return?.();
  }
};

const readInput = async (input: CliInput, io: CliIo): Promise<string> => {
  io.signal?.throwIfAborted();
  if (input.kind === "expression") return input.value;
  if (input.kind === "stdin") return stdinText(io.stdin, io.signal);
  return readFile(input.value, "utf8");
};

const diagnosticsOf = (adapters: readonly Adapter[]): readonly Diagnostic[] => adapters.flatMap((adapter) => adapter.diagnostics?.() ?? []);

export const runCli = async (args: readonly string[], io: CliIo): Promise<number> => {
  try {
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h" || args[0] === "help")) {
      io.stdout.write(`${usage}\n`);
      return EXIT.success;
    }
    if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
      io.stdout.write(`ast ${version}\n`);
      return EXIT.success;
    }
    const normalizedArgs = args[0] === "help" && args.length === 2
      ? [args[1] ?? "", "--help"]
      : args;
    const parsed = parseArguments(normalizedArgs);
    const command = validateArguments(parsed);
    if (parsed.help) {
      io.stdout.write(commandHelp[command]);
      return EXIT.success;
    }
    const config = await loadConfig(parsed, io);
    const runtime = await createRuntime(config, io.cwd);
    if (command === "schema") {
      const requested = parsed.positional[0];
      const namespace = requested === undefined ? undefined : runtime.plugins.aliases.namespaces[requested] ?? requested;
      const schema = namespace === undefined ? undefined : runtime.schemas[namespace];
      if (schema === undefined) throw new TypeError(`Unknown adapter namespace ${JSON.stringify(requested)}.`);
      io.stdout.write(`${JSON.stringify(serializable(schema), undefined, config.format === "pretty" ? 2 : undefined)}\n`);
      return EXIT.success;
    }
    if (command === "plugins") {
      const values = {
        builtIns: runtime.adapters
          .filter(({ plugin }) => plugin === undefined)
          .map((adapter) => {
            const compatibility = adapterCompatibility(adapter);
            return {
              contractVersion: compatibility.contractVersion,
              namespace: compatibility.namespace,
              schemaVersion: compatibility.schemaVersion,
              builtIn: true,
            };
          }),
        plugins: runtime.plugins.plugins.map((plugin) => {
          const configured = config.plugins.find(({ name }) => name === plugin.name);
          return {
            apiVersion: plugin.apiVersion,
            name: plugin.name,
            version: plugin.version,
            integrity: plugin.integrity,
            namespaces: plugin.namespaces,
            powers: plugin.powers,
            contributions: plugin.contributions,
            approvedPowers: configured?.powers ?? [],
            aliases: configured?.aliases ?? {},
            adapters: runtime.adapters
              .filter((adapter) => adapter.plugin?.name === plugin.name)
              .map(adapterCompatibility),
            trustedCode: true,
            isolated: false,
          };
        }),
      };
      io.stdout.write(`${JSON.stringify(values, undefined, config.format === "pretty" ? 2 : undefined)}\n`);
      return EXIT.success;
    }
    const input = resolveInput(parsed, io.cwd);
    const text = await readInput(input, io);
    let savedPlan: ChangePlan | undefined;
    if (command === "apply") {
      let planShaped = false;
      try {
        const parsedInput = JSON.parse(text) as unknown;
        planShaped = input.kind !== "expression"
          && parsedInput !== null
          && typeof parsedInput === "object"
          && !Array.isArray(parsedInput)
          && ["integrity", "plan", "formatVersion"].some((field) => field in parsedInput);
      } catch { /* Non-JSON input is treated as DSL. */ }
      if (planShaped) {
        try {
          savedPlan = deserializeChangePlan(text, { adapters: runtime.adapters });
        } catch (error) {
          io.stderr.write(line({ type: "diagnostic", value: { code: "cli.invalid-plan", severity: "error", message: error instanceof Error ? error.message : "Invalid saved plan." } }));
          return EXIT.invalidPlan;
        }
      }
    }
    const compiled = savedPlan === undefined
      ? compileDsl(text, runtime.environment, { uri: input.uri })
      : undefined;
    if (command === "query") {
      if (compiled?.kind !== "query") throw new TypeError("query requires a query program.");
      const renderer = selectPresentation(
        parsed.renderer,
        runtime.plugins.aliases.renderers,
        runtime.plugins.renderers,
        "renderer",
      );
      for await (const value of compiled.query.iterate(io.signal === undefined ? {} : { signal: io.signal })) {
        if (renderer !== undefined && config.format === "pretty" && io.stdoutIsTTY) io.stdout.write(renderPluginValue(renderer, value));
        else emit(io, config.format, value);
      }
      const diagnostics = diagnosticsOf(runtime.adapters);
      for (const diagnostic of diagnostics) emitDiagnostic(io, diagnostic);
      return diagnostics.some(({ severity }) => severity === "error")
        ? EXIT.diagnostic
        : EXIT.success;
    }
    if (command === "explain") {
      if (compiled?.kind === "query") io.stdout.write(`${JSON.stringify(serializable(compiled.query.explain()), undefined, 2)}\n`);
      else if (compiled?.kind === "plan") {
        const plan = await compiled.plan();
        io.stdout.write(`${JSON.stringify(serializable({ changes: plan.changes.map(({ id, risk, summary }) => ({ id, risk, summary })), diagnostics: plan.diagnostics, transactionGroups: plan.transactionGroups }), undefined, 2)}\n`);
      } else throw new TypeError("explain requires a DSL program.");
      return EXIT.success;
    }
    let plan = savedPlan;
    if (plan === undefined) {
      if (compiled?.kind !== "plan") throw new TypeError(`${command} requires a transformation program or saved plan.`);
      plan = await compiled.plan();
    }
    if (plan.diagnostics.some(({ severity }) => severity === "error")) {
      for (const diagnostic of plan.diagnostics) emitDiagnostic(io, diagnostic);
      return EXIT.invalidPlan;
    }
    if (command === "plan") {
      const diffProvider = selectPresentation(
        parsed.diffProvider,
        runtime.plugins.aliases.diffProviders,
        runtime.plugins.diffProviders,
        "diff provider",
      );
      io.stdout.write(diffProvider !== undefined && io.stdoutIsTTY
        ? renderPluginPlan(plan, diffProvider)
        : renderChangePlan(plan));
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
    if (error instanceof CliUsageError || error instanceof CliConfigError) {
      io.stderr.write(line({ type: "diagnostic", value: { code: error.code, severity: "error", message: error.message } }));
      return EXIT.usage;
    }
    if (error instanceof DslError) for (const value of error.diagnostics) emitDiagnostic(io, value);
    else if (error instanceof PluginError) io.stderr.write(line({ type: "diagnostic", value: { code: error.code, severity: "error", message: error.message } }));
    else io.stderr.write(line({ type: "diagnostic", value: { code: "cli.error", severity: "error", message: error instanceof Error ? error.message : "Unknown CLI failure." } }));
    return EXIT.diagnostic;
  }
};
