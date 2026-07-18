import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  Adapter,
  ApplyCapability,
  ApplyResult,
  MountCapability,
  AttributeProjection,
  OpenContext,
  Operation,
  PlanningCapability,
  ReadCapability,
  ResourceHandle,
  RootRequest,
  SourceDescriptor,
} from "./adapter.js";
import type {
  Change,
  ChangePrecondition,
  ChangeRegion,
  ChangeTransaction,
  TextChangePreview,
} from "./change.js";
import { defineDiagnostic } from "./diagnostic.js";
import type { Diagnostic } from "./diagnostic.js";
import { immutableCopy } from "./immutable.js";
import type { JsonAdapter } from "./json.js";
import { mountJsonTextHandle } from "./json.js";
import { defineEdge, defineNodeSnapshot, defineResource } from "./model.js";
import type {
  EdgeRequest,
  EdgeName,
  NodeId,
  NodeSnapshot,
  Resource,
  Revision,
  SourceRange,
} from "./model.js";
import { fromValues } from "./query.js";
import type { CaptureMap, NavigableNodeHandle, Query } from "./query.js";
import { defineAdapterSchema } from "./schema.js";
import type { IdentityGuarantee, NodeKindSchema } from "./schema.js";

export type MarkdownNodeKind =
  | "markdown::document"
  | "markdown::frontmatter"
  | "markdown::heading"
  | "markdown::section"
  | "markdown::paragraph"
  | "markdown::list"
  | "markdown::list-item"
  | "markdown::link"
  | "markdown::code-block";

export type MarkdownTreeView = "markdown::syntax-tree" | "markdown::section-tree";

export interface MarkdownSource {
  readonly uri: string;
  readonly treeView?: MarkdownTreeView;
}

export interface MarkdownAdapterOptions {
  readonly json?: JsonAdapter;
}

export interface MarkdownMountOptions {
  readonly treeView?: MarkdownTreeView;
}

const markdownTreeView = (selected: string | undefined): MarkdownTreeView => {
  if (selected === undefined || selected === "markdown::syntax-tree") {
    return "markdown::syntax-tree";
  }
  if (selected === "markdown::section-tree") return selected;
  throw new TypeError(`Unknown Markdown tree view ${JSON.stringify(selected)}.`);
};

export type MarkdownOperationKind =
  | "markdown::set-heading"
  | "markdown::replace-section";

interface MarkdownOperationBase<Kind extends MarkdownOperationKind, Payload>
  extends Operation<Kind, Payload> {
  readonly target: NodeId;
  readonly expectedRevision?: Revision;
}

export type MarkdownSetHeadingOperation = MarkdownOperationBase<
  "markdown::set-heading",
  { readonly title: string }
>;
export type MarkdownReplaceSectionOperation = MarkdownOperationBase<
  "markdown::replace-section",
  { readonly content: string }
>;
export type MarkdownOperation =
  | MarkdownSetHeadingOperation
  | MarkdownReplaceSectionOperation;

export interface MarkdownPrecondition extends ChangePrecondition {
  readonly expectedRevision: Revision;
}

export interface MarkdownPatchPayload {
  readonly uri: string;
  readonly encoding: "utf8" | "utf8-bom";
  readonly range: SourceRange;
  readonly replacement: string;
  readonly original: string;
  readonly content: string;
  readonly formatting: string;
}

export interface MarkdownChange extends Change<MarkdownPatchPayload> {
  readonly adapter: "markdown";
  readonly kind: MarkdownOperationKind;
  readonly risk: "destructive";
  readonly reversible: true;
  readonly preconditions: readonly MarkdownPrecondition[];
  readonly regions: readonly ChangeRegion[];
  readonly preview: TextChangePreview;
  readonly transaction: ChangeTransaction;
}

export interface MarkdownStatistics {
  readonly opened: number;
  readonly closed: number;
  readonly filesRead: number;
  readonly bytesRead: number;
  readonly parses: number;
}

export interface MarkdownAdapter extends Adapter {
  readonly namespace: "markdown";
  readonly read: ReadCapability;
  readonly planning: PlanningCapability<MarkdownOperation, MarkdownChange>;
  readonly apply: ApplyCapability<MarkdownChange, ApplyResult>;
  readonly mount: MountCapability;
  diagnostics(): readonly Diagnostic[];
  statistics(): MarkdownStatistics;
}

interface Line {
  readonly text: string;
  readonly start: number;
  readonly contentEnd: number;
  readonly end: number;
}

interface Block {
  readonly local: string;
  readonly kind: Exclude<MarkdownNodeKind, "markdown::document" | "markdown::section" | "markdown::link" | "markdown::list-item">;
  readonly start: number;
  readonly end: number;
  readonly attributes: NodeSnapshot["attributes"];
  readonly titleStart?: number;
  readonly titleEnd?: number;
  readonly contentStart?: number;
  readonly contentEnd?: number;
  readonly childLocals: readonly string[];
}

interface SectionRecord {
  readonly local: string;
  readonly headingLocal: string;
  readonly level: number;
  readonly title: string;
  readonly start: number;
  readonly end: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly childLocals: readonly string[];
}

interface NodeRecord {
  readonly snapshot: NodeSnapshot;
  readonly childLocals: readonly string[];
  readonly parentByEdge: Readonly<Record<string, string>>;
  readonly titleRange?: SourceRange;
  readonly bodyRange?: SourceRange;
}

interface ResourceState {
  readonly resource: Resource;
  readonly path: string;
  readonly text: string;
  readonly bom: boolean;
  readonly view: MarkdownTreeView;
  readonly nodes: ReadonlyMap<string, NodeRecord>;
  readonly container?: NodeSnapshot;
}

interface MutableStatistics {
  opened: number;
  closed: number;
  filesRead: number;
  bytesRead: number;
  parses: number;
}

const identity: IdentityGuarantee = Object.freeze({
  stability: "revision",
  description: "source-order block path within one Markdown file revision; derived section IDs follow heading order",
});

const kind = (
  name: MarkdownNodeKind,
  attributes: NodeKindSchema["attributes"],
): NodeKindSchema => ({ kind: name, attributes, identity });

const schema = defineAdapterSchema({
  namespace: "markdown",
  version: "1.0.0",
  dynamic: false,
  kinds: [
    kind("markdown::document", {
      encoding: { scalar: "string", cardinality: "one", required: true },
      finalNewline: { scalar: "boolean", cardinality: "one", required: true },
    }),
    kind("markdown::frontmatter", {
      format: { scalar: "string", cardinality: "one", required: true },
      content: { scalar: "string", cardinality: "one", required: true },
    }),
    kind("markdown::heading", {
      level: { scalar: "number", cardinality: "one", required: true },
      title: { scalar: "string", cardinality: "one", required: true },
    }),
    kind("markdown::section", {
      level: { scalar: "number", cardinality: "one", required: true },
      title: { scalar: "string", cardinality: "one", required: true },
    }),
    kind("markdown::paragraph", {
      text: { scalar: "string", cardinality: "one", required: true },
      html: { scalar: "boolean", cardinality: "one", required: true },
    }),
    kind("markdown::list", {
      ordered: { scalar: "boolean", cardinality: "one", required: true },
      size: { scalar: "number", cardinality: "one", required: true },
    }),
    kind("markdown::list-item", {
      text: { scalar: "string", cardinality: "one", required: true },
      index: { scalar: "number", cardinality: "one", required: true },
    }),
    kind("markdown::link", {
      text: { scalar: "string", cardinality: "one", required: true },
      destination: { scalar: "string", cardinality: "one", required: true },
      reference: { scalar: "boolean", cardinality: "one", required: true },
    }),
    kind("markdown::code-block", {
      language: { scalar: "string", cardinality: "one", required: true },
      content: { scalar: "string", cardinality: "one", required: true },
      closed: { scalar: "boolean", cardinality: "one", required: true },
    }),
  ],
  edges: [
    {
      name: "markdown::mount",
      role: "child",
      from: ["fs::file"],
      to: ["markdown::document"],
      ordering: "stable",
    },
    {
      name: "markdown::children",
      role: "child",
      from: ["markdown::document", "markdown::paragraph", "markdown::list", "markdown::list-item", "markdown::heading"],
      to: ["markdown::frontmatter", "markdown::heading", "markdown::paragraph", "markdown::list", "markdown::list-item", "markdown::link", "markdown::code-block"],
      ordering: "stable",
    },
    {
      name: "markdown::sections",
      role: "child",
      from: ["markdown::document", "markdown::section"],
      to: ["markdown::section", "markdown::heading", "markdown::paragraph", "markdown::list", "markdown::code-block", "markdown::frontmatter"],
      ordering: "stable",
    },
    {
      name: "markdown::container",
      role: "reference",
      from: ["markdown::document", "markdown::code-block"],
      to: ["fs::file"],
      ordering: "stable",
    },
  ],
  operations: [
    { kind: "markdown::set-heading", arguments: { title: { type: "string", cardinality: "one", required: true } } },
    { kind: "markdown::replace-section", arguments: { content: { type: "string", cardinality: "one", required: true } } },
  ],
  treeViews: [
    { name: "markdown::syntax-tree", rootKinds: ["markdown::document"], childEdges: ["markdown::mount", "markdown::children"], default: true },
    { name: "markdown::section-tree", rootKinds: ["markdown::document"], childEdges: ["markdown::mount", "markdown::sections"] },
  ],
  capabilities: {
    traversal: ["tree", "reference"],
    pushdown: [],
    ordering: "stable",
    revisions: true,
    transactions: "local",
    semanticOperations: true,
    parallelReads: true,
    parallelWrites: false,
  },
});

const throwIfAborted = (signal: AbortSignal | undefined): void => signal?.throwIfAborted();
const revisionOf = (stat: Awaited<ReturnType<typeof lstat>>): Revision =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
const sourcePath = (uri: string): string => uri.startsWith("file:") ? fileURLToPath(uri) : uri;
const range = (start: number, end: number): SourceRange => ({ start, end });
const resourceKey = (uri: string, view: MarkdownTreeView, container?: NodeSnapshot): string =>
  createHash("sha256")
    .update(uri)
    .update("\0")
    .update(view)
    .update("\0")
    .update(container === undefined ? "standalone" : `${container.id.resource}:${container.id.local}`)
    .digest("base64url")
    .slice(0, 24);

const linesOf = (text: string): readonly Line[] => {
  const lines: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline + 1;
    const contentEnd = newline < 0 ? text.length : newline > start && text[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({ text: text.slice(start, contentEnd), start, contentEnd, end });
    start = end;
  }
  return lines;
};

interface ParsedMarkdown {
  readonly blocks: readonly Block[];
  readonly sections: readonly SectionRecord[];
  readonly diagnostics: readonly { readonly code: string; readonly message: string; readonly start: number; readonly end: number }[];
}

const linksFor = (
  value: string,
  base: number,
  parentLocal: string,
  references: ReadonlyMap<string, string>,
): readonly { readonly local: string; readonly start: number; readonly end: number; readonly text: string; readonly destination: string; readonly reference: boolean }[] => {
  const links: { local: string; start: number; end: number; text: string; destination: string; reference: boolean }[] = [];
  const expression = /\[([^\]]+)\](?:\(([^)]+)\)|\[([^\]]+)\])/gu;
  for (const [index, match] of [...value.matchAll(expression)].entries()) {
    const destination = match[2] ?? references.get((match[3] ?? "").toLowerCase());
    if (destination === undefined || match.index === undefined) continue;
    links.push({
      local: `${parentLocal}/link:${index}`,
      start: base + match.index,
      end: base + match.index + match[0].length,
      text: match[1] ?? "",
      destination,
      reference: match[2] === undefined,
    });
  }
  return links;
};

const parseMarkdown = (text: string): ParsedMarkdown => {
  const lines = linesOf(text);
  const references = new Map<string, string>();
  for (const line of lines) {
    const reference = /^\[([^\]]+)\]:\s*(\S+)/u.exec(line.text);
    if (reference?.[1] !== undefined && reference[2] !== undefined) {
      references.set(reference[1].toLowerCase(), reference[2]);
    }
  }
  const blocks: Block[] = [];
  const diagnostics: { code: string; message: string; start: number; end: number }[] = [];
  let index = 0;
  const add = (block: Omit<Block, "local">): void => {
    blocks.push({ ...block, local: `block:${blocks.length}` });
  };

  if (lines[0]?.text === "---") {
    let close = 1;
    while (close < lines.length && lines[close]?.text !== "---") close += 1;
    if (close < lines.length) {
      const end = lines[close]?.end ?? lines[0].end;
      add({
        kind: "markdown::frontmatter",
        start: lines[0].start,
        end,
        attributes: {
          format: "yaml",
          content: text.slice(lines[0].end, lines[close]?.start ?? end),
        },
        childLocals: [],
      });
      index = close + 1;
    } else {
      diagnostics.push({
        code: "markdown.unclosed-frontmatter",
        message: "Frontmatter opening delimiter has no closing delimiter.",
        start: lines[0].start,
        end: lines[0].contentEnd,
      });
    }
  }

  let previousHeadingLevel = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.text.trim().length === 0) {
      index += 1;
      continue;
    }
    const fence = /^( {0,3})(`{3,}|~{3,})([^`]*)$/u.exec(line.text);
    if (fence !== null) {
      const marker = fence[2] ?? "```";
      let close = index + 1;
      while (close < lines.length) {
        const candidate = lines[close]?.text.trim() ?? "";
        if (candidate.startsWith(marker[0] ?? "`") && candidate.length >= marker.length) break;
        close += 1;
      }
      const closed = close < lines.length;
      const contentStart = line.end;
      const contentEnd = closed ? lines[close]?.start ?? text.length : text.length;
      const end = closed ? lines[close]?.end ?? text.length : text.length;
      add({
        kind: "markdown::code-block",
        start: line.start,
        end,
        contentStart,
        contentEnd,
        attributes: {
          language: (fence[3] ?? "").trim().split(/\s/u)[0] ?? "",
          content: text.slice(contentStart, contentEnd),
          closed,
        },
        childLocals: [],
      });
      if (!closed) diagnostics.push({
        code: "markdown.unclosed-fence",
        message: "Fenced code block is not closed before end of file.",
        start: line.start,
        end: line.contentEnd,
      });
      index = closed ? close + 1 : lines.length;
      continue;
    }
    const heading = /^( {0,3})(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/u.exec(line.text);
    if (heading !== null) {
      const level = heading[2]?.length ?? 1;
      const rawTitle = heading[3] ?? "";
      const titleOffset = line.text.indexOf(rawTitle);
      const local = `block:${blocks.length}`;
      const links = linksFor(rawTitle, line.start + titleOffset, local, references);
      add({
        kind: "markdown::heading",
        start: line.start,
        end: line.end,
        titleStart: line.start + titleOffset,
        titleEnd: line.start + titleOffset + rawTitle.length,
        attributes: { level, title: rawTitle },
        childLocals: links.map(({ local: child }) => child),
      });
      if (previousHeadingLevel > 0 && level > previousHeadingLevel + 1) {
        diagnostics.push({
          code: "markdown.skipped-heading-level",
          message: `Heading level jumps from ${previousHeadingLevel} to ${level}.`,
          start: line.start,
          end: line.contentEnd,
        });
      }
      previousHeadingLevel = level;
      index += 1;
      continue;
    }
    const listItem = /^( {0,3})(?:([-+*])|([0-9]+)[.)])[\t ]+(.+)$/u.exec(line.text);
    if (listItem !== null) {
      const ordered = listItem[3] !== undefined;
      const start = line.start;
      const items: { line: Line; text: string }[] = [];
      while (index < lines.length) {
        const candidate = lines[index];
        if (candidate === undefined) break;
        const match = /^( {0,3})(?:([-+*])|([0-9]+)[.)])[\t ]+(.+)$/u.exec(candidate.text);
        if (match === null || (match[3] !== undefined) !== ordered) break;
        items.push({ line: candidate, text: match[4] ?? "" });
        index += 1;
      }
      const local = `block:${blocks.length}`;
      add({
        kind: "markdown::list",
        start,
        end: items.at(-1)?.line.end ?? line.end,
        attributes: { ordered, size: items.length },
        childLocals: items.map((_, itemIndex) => `${local}/item:${itemIndex}`),
      });
      continue;
    }
    const paragraphStart = index;
    index += 1;
    while (index < lines.length) {
      const candidate = lines[index];
      if (
        candidate === undefined ||
        candidate.text.trim().length === 0 ||
        /^( {0,3})(#{1,6})[\t ]+/u.test(candidate.text) ||
        /^( {0,3})(`{3,}|~{3,})/u.test(candidate.text) ||
        /^( {0,3})(?:[-+*]|[0-9]+[.)])[\t ]+/u.test(candidate.text)
      ) break;
      index += 1;
    }
    const selected = lines.slice(paragraphStart, index);
    const start = selected[0]?.start ?? line.start;
    const end = selected.at(-1)?.end ?? line.end;
    const value = text.slice(start, end).replace(/[\r\n]+$/u, "");
    const local = `block:${blocks.length}`;
    const links = linksFor(value, start, local, references);
    add({
      kind: "markdown::paragraph",
      start,
      end,
      attributes: { text: value, html: /^\s*</u.test(value) },
      childLocals: links.map(({ local: child }) => child),
    });
  }

  const headingBlocks = blocks.filter((block) => block.kind === "markdown::heading");
  const sections: SectionRecord[] = headingBlocks.map((heading, headingIndex) => {
    const level = heading.attributes.level as number;
    const nextPeer = headingBlocks.slice(headingIndex + 1).find(
      (candidate) => (candidate.attributes.level as number) <= level,
    );
    const nextHeading = headingBlocks[headingIndex + 1];
    const end = nextPeer?.start ?? text.length;
    const bodyEnd = nextHeading !== undefined && nextHeading.start < end ? nextHeading.start : end;
    return {
      local: `section:${headingIndex}`,
      headingLocal: heading.local,
      level,
      title: String(heading.attributes.title),
      start: heading.start,
      end,
      bodyStart: heading.end,
      bodyEnd,
      childLocals: [],
    };
  });
  const sectionChildren = new Map<string, string[]>();
  for (const section of sections) sectionChildren.set(section.local, []);
  for (const section of sections) {
    const parent = [...sections]
      .slice(0, sections.indexOf(section))
      .toReversed()
      .find((candidate) => candidate.level < section.level && candidate.end >= section.end);
    if (parent !== undefined) sectionChildren.get(parent.local)?.push(section.local);
  }
  return {
    blocks,
    sections: sections.map((section) => ({
      local: section.local,
      headingLocal: section.headingLocal,
      level: section.level,
      title: section.title,
      start: section.start,
      end: section.end,
      bodyStart: section.bodyStart,
      bodyEnd: section.bodyEnd,
      childLocals: sectionChildren.get(section.local) ?? [],
    })),
    diagnostics,
  };
};

const buildRecords = (
  resource: Resource,
  text: string,
  bom: boolean,
  parsed: ParsedMarkdown,
): ReadonlyMap<string, NodeRecord> => {
  const records = new Map<string, NodeRecord>();
  const parents = new Map<string, Record<string, string>>();
  const origin = (start: number, end: number) => ({
    uri: resource.uri,
    ...(resource.revision === undefined ? {} : { revision: resource.revision }),
    range: range(start, end),
  });
  const put = (
    local: string,
    nodeKind: MarkdownNodeKind,
    attributes: NodeSnapshot["attributes"],
    start: number,
    end: number,
    childLocals: readonly string[],
    extra: Pick<NodeRecord, "titleRange" | "bodyRange"> = {},
  ): void => {
    records.set(local, {
      snapshot: defineNodeSnapshot({
        id: { adapter: "markdown", resource: resource.id, local },
        kind: nodeKind,
        attributes,
        origin: origin(start, end),
      }),
      childLocals,
      parentByEdge: {},
      ...extra,
    });
  };

  const syntaxChildren = parsed.blocks.map(({ local }) => local);
  put(
    "$syntax",
    "markdown::document",
    { encoding: bom ? "utf8-bom" : "utf8", finalNewline: /[\r\n]$/u.test(text) },
    0,
    text.length,
    syntaxChildren,
  );
  const sectionLocals = new Set(parsed.sections.map(({ local }) => local));
  const nestedSections = new Set(parsed.sections.flatMap(({ childLocals }) => childLocals));
  const semanticRoots = parsed.sections
    .filter(({ local }) => !nestedSections.has(local))
    .map(({ local }) => local);
  put(
    "$sections",
    "markdown::document",
    { encoding: bom ? "utf8-bom" : "utf8", finalNewline: /[\r\n]$/u.test(text) },
    0,
    text.length,
    semanticRoots,
  );

  const references = new Map<string, string>();
  for (const line of linesOf(text)) {
    const reference = /^\[([^\]]+)\]:\s*(\S+)/u.exec(line.text);
    if (reference?.[1] !== undefined && reference[2] !== undefined) {
      references.set(reference[1].toLowerCase(), reference[2]);
    }
  }
  for (const block of parsed.blocks) {
    let children = block.childLocals;
    if (block.kind === "markdown::list") {
      const listLines = linesOf(text.slice(block.start, block.end));
      children = listLines.map((_, index) => `${block.local}/item:${index}`);
    }
    put(
      block.local,
      block.kind,
      block.attributes,
      block.start,
      block.end,
      children,
      block.titleStart === undefined || block.titleEnd === undefined
        ? {}
        : { titleRange: range(block.titleStart, block.titleEnd) },
    );
    if (block.kind === "markdown::paragraph" || block.kind === "markdown::heading") {
      const value = block.kind === "markdown::heading"
        ? String(block.attributes.title)
        : String(block.attributes.text);
      const base = block.kind === "markdown::heading" ? block.titleStart ?? block.start : block.start;
      for (const link of linksFor(value, base, block.local, references)) {
        put(
          link.local,
          "markdown::link",
          { text: link.text, destination: link.destination, reference: link.reference },
          link.start,
          link.end,
          [],
        );
      }
    }
    if (block.kind === "markdown::list") {
      const selectedLines = linesOf(text.slice(block.start, block.end));
      selectedLines.forEach((line, index) => {
        const absoluteStart = block.start + line.start;
        const match = /^( {0,3})(?:[-+*]|[0-9]+[.)])[\t ]+(.+)$/u.exec(line.text);
        const value = match?.[2] ?? "";
        const valueOffset = line.text.indexOf(value);
        const local = `${block.local}/item:${index}`;
        const links = linksFor(value, absoluteStart + valueOffset, local, references);
        put(
          local,
          "markdown::list-item",
          { text: value, index },
          absoluteStart,
          block.start + line.end,
          links.map(({ local: child }) => child),
        );
        for (const link of links) {
          put(
            link.local,
            "markdown::link",
            { text: link.text, destination: link.destination, reference: link.reference },
            link.start,
            link.end,
            [],
          );
        }
      });
    }
  }

  for (const section of parsed.sections) {
    const bodyBlocks = parsed.blocks
      .filter(
        (block) =>
          !sectionLocals.has(block.local) &&
          block.start >= section.bodyStart &&
          block.end <= section.bodyEnd,
      )
      .map(({ local }) => local);
    put(
      section.local,
      "markdown::section",
      { level: section.level, title: section.title },
      section.start,
      section.end,
      [section.headingLocal, ...bodyBlocks, ...section.childLocals],
      { bodyRange: range(section.bodyStart, section.bodyEnd) },
    );
  }

  const assignParents = (parent: string, edge: string): void => {
    const record = records.get(parent);
    for (const child of record?.childLocals ?? []) {
      const value = parents.get(child) ?? {};
      value[edge] = parent;
      parents.set(child, value);
    }
  };
  assignParents("$syntax", "markdown::children");
  assignParents("$sections", "markdown::sections");
  for (const block of parsed.blocks) assignParents(block.local, "markdown::children");
  for (const section of parsed.sections) assignParents(section.local, "markdown::sections");
  for (const [local, record] of records) {
    records.set(local, { ...record, parentByEdge: Object.freeze(parents.get(local) ?? {}) });
  }
  return records;
};

const operationTarget = (snapshot: NodeSnapshot) => ({
  resource: snapshot.id.resource,
  target: snapshot.id,
  ...(snapshot.origin?.revision === undefined ? {} : { expectedRevision: snapshot.origin.revision }),
});

export const markdownSetHeading = (
  heading: NodeSnapshot,
  title: string,
): MarkdownSetHeadingOperation => {
  if (heading.id.adapter !== "markdown" || heading.kind !== "markdown::heading") {
    throw new TypeError("Expected a Markdown heading node.");
  }
  if (/[\r\n]/u.test(title)) throw new TypeError("Markdown heading text must remain on one line.");
  return immutableCopy({
    kind: "markdown::set-heading",
    ...operationTarget(heading),
    payload: { title },
  });
};

export const markdownReplaceSection = (
  section: NodeSnapshot,
  content: string,
): MarkdownReplaceSectionOperation => {
  if (section.id.adapter !== "markdown" || section.kind !== "markdown::section") {
    throw new TypeError("Expected a Markdown section node.");
  }
  return immutableCopy({
    kind: "markdown::replace-section",
    ...operationTarget(section),
    payload: { content },
  });
};

interface MarkdownInternals {
  openMounted(
    container: NodeSnapshot,
    treeView: MarkdownTreeView,
    context: OpenContext,
  ): Promise<ResourceHandle | undefined>;
}

const internals = new WeakMap<MarkdownAdapter, MarkdownInternals>();

const wants = (request: EdgeRequest, name: EdgeName, role: "child" | "reference"): boolean =>
  (request.names === undefined || request.names.includes(name)) &&
  (request.roles === undefined || request.roles.includes(role)) &&
  (request.direction ?? "forward") === "forward";

const markdownHandle = (
  adapter: MarkdownAdapter,
  snapshot: NodeSnapshot,
  container: NavigableNodeHandle | undefined,
  json: JsonAdapter | undefined,
): NavigableNodeHandle => {
  const base: NavigableNodeHandle = Object.freeze({
    snapshot,
    edges(request: EdgeRequest = {}) {
      return adapter.read.edges(snapshot.id, request);
    },
    async resolve(id: NodeId, signal?: AbortSignal) {
      throwIfAborted(signal);
      if (id.adapter !== "markdown") {
        if (container === undefined) return undefined;
        if (
          id.adapter === container.snapshot.id.adapter &&
          id.resource === container.snapshot.id.resource &&
          id.local === container.snapshot.id.local
        ) return container;
        return container.resolve(id, signal);
      }
      const [resolved] = await adapter.read.hydrate([id], {
        attributes: [],
        ...(signal === undefined ? {} : { signal }),
      });
      return resolved === undefined ? undefined : markdownHandle(adapter, resolved, container, json);
    },
  });
  if (
    json !== undefined &&
    snapshot.kind === "markdown::code-block" &&
    snapshot.attributes.language === "json" &&
    typeof snapshot.attributes.content === "string"
  ) {
    return mountJsonTextHandle(base, json, {
      text: snapshot.attributes.content,
      uri: `${snapshot.origin?.uri ?? "markdown:embedded"}#${snapshot.id.local}`,
      ...(snapshot.origin?.revision === undefined ? {} : { revision: snapshot.origin.revision }),
    });
  }
  return base;
};

const mountedFileHandle = (
  file: NavigableNodeHandle,
  adapter: MarkdownAdapter,
  json: JsonAdapter | undefined,
  treeView: MarkdownTreeView,
): NavigableNodeHandle =>
  Object.freeze({
    snapshot: file.snapshot,
    edges(request: EdgeRequest = {}) {
      return {
        async *[Symbol.asyncIterator]() {
          for await (const edge of file.edges(request)) yield edge;
          if (file.snapshot.kind !== "fs::file" || !wants(request, "markdown::mount", "child")) return;
          const implementation = internals.get(adapter);
          if (implementation === undefined) throw new TypeError("Unknown Markdown adapter instance.");
          const handle = await implementation.openMounted(
            file.snapshot,
            treeView,
            request.signal === undefined ? {} : { signal: request.signal },
          );
          if (handle === undefined) return;
          try {
            for await (const root of adapter.read.roots(handle.resource, request)) {
              yield defineEdge({
                name: "markdown::mount",
                role: "child",
                from: file.snapshot.id,
                to: root.id,
                ordinal: 0,
              });
            }
          } finally {
            await handle.close();
          }
        },
      };
    },
    async resolve(id: NodeId, signal?: AbortSignal) {
      if (id.adapter !== "markdown") return file.resolve(id, signal);
      const [resolved] = await adapter.read.hydrate([id], {
        attributes: [],
        ...(signal === undefined ? {} : { signal }),
      });
      return resolved === undefined ? undefined : markdownHandle(adapter, resolved, file, json);
    },
  });

export const mountMarkdown = <Captures extends CaptureMap>(
  files: Query<NavigableNodeHandle, Captures>,
  adapter: MarkdownAdapter,
  options: MarkdownMountOptions = {},
): Query<NavigableNodeHandle, Captures> => {
  const json = (adapter as MarkdownAdapter & { readonly mountedJson?: JsonAdapter }).mountedJson;
  const treeView = markdownTreeView(options.treeView);
  return files.project(
    (file) => mountedFileHandle(file, adapter, json, treeView),
    `mount markdown (${treeView})`,
  );
};

export const createMarkdownAdapter = (
  options: MarkdownAdapterOptions = {},
): MarkdownAdapter => {
  const resources = new Map<string, ResourceState>();
  const diagnostics: Diagnostic[] = [];
  const statistics: MutableStatistics = { opened: 0, closed: 0, filesRead: 0, bytesRead: 0, parses: 0 };

  const stateFor = (resource: Resource | string): ResourceState => {
    const id = typeof resource === "string" ? resource : resource.id;
    const state = resources.get(id);
    if (state === undefined) throw new TypeError(`Unknown Markdown resource ${id}.`);
    return state;
  };

  const load = async (
    uri: string,
    view: MarkdownTreeView,
    container: NodeSnapshot | undefined,
    context: OpenContext,
  ): Promise<ResourceHandle | undefined> => {
    throwIfAborted(context.signal);
    statistics.opened += 1;
    let closed = false;
    const close = async (): Promise<void> => {
      if (!closed) {
        closed = true;
        statistics.closed += 1;
      }
    };
    try {
      const path = sourcePath(uri);
      const before = await lstat(path);
      const bytes = await readFile(path);
      statistics.filesRead += 1;
      statistics.bytesRead += bytes.byteLength;
      const after = await lstat(path);
      const revision = revisionOf(after);
      if (revisionOf(before) !== revision) throw new Error("Markdown file changed while being read.");
      if (container?.origin?.revision !== undefined && container.origin.revision !== revision) {
        diagnostics.push(defineDiagnostic({
          code: "markdown.revision-conflict",
          severity: "error",
          message: `Cannot mount ${uri}: the file changed after filesystem observation.`,
          locations: [{ kind: "node", node: container.id, origin: container.origin }],
        }));
        await close();
        return undefined;
      }
      const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const bom = decoded.startsWith("\uFEFF");
      const text = bom ? decoded.slice(1) : decoded;
      statistics.parses += 1;
      const parsed = parseMarkdown(text);
      const resource = defineResource({
        id: resourceKey(uri, view, container),
        adapter: "markdown",
        uri,
        revision,
      });
      for (const issue of parsed.diagnostics) {
        diagnostics.push(defineDiagnostic({
          code: issue.code,
          severity: "warning",
          message: issue.message,
          locations: [{ kind: "source", origin: { uri, revision, range: range(issue.start, issue.end) } }],
        }));
      }
      const state: ResourceState = Object.freeze({
        resource,
        path,
        text,
        bom,
        view,
        nodes: buildRecords(resource, text, bom, parsed),
        ...(container === undefined ? {} : { container }),
      });
      resources.set(resource.id, state);
      return Object.freeze({ resource, close });
    } catch (error) {
      await close();
      throw error;
    }
  };

  const read: ReadCapability = {
    async open(source: SourceDescriptor, context: OpenContext) {
      const view = markdownTreeView(source.treeView ?? source.options?.treeView as string | undefined);
      const uri = pathToFileURL(sourcePath(source.uri)).href;
      const handle = await load(uri, view, undefined, context);
      if (handle === undefined) throw new Error(`Cannot open Markdown source ${uri}.`);
      return handle;
    },
    roots(resource, request: RootRequest) {
      return {
        async *[Symbol.asyncIterator]() {
          throwIfAborted(request.signal);
          const state = stateFor(resource);
          const local = state.view === "markdown::section-tree" ? "$sections" : "$syntax";
          const root = state.nodes.get(local);
          if (root !== undefined) yield root.snapshot;
        },
      };
    },
    edges(node, request) {
      return {
        async *[Symbol.asyncIterator]() {
          throwIfAborted(request.signal);
          if (node.adapter !== "markdown") return;
          const state = stateFor(node.resource);
          const record = state.nodes.get(node.local);
          if (record === undefined) return;
          const edgeName = node.local === "$sections" || node.local.startsWith("section:")
            ? "markdown::sections" as const
            : "markdown::children" as const;
          const direction = request.direction ?? "forward";
          if (direction === "forward") {
            if (wants(request, edgeName, "child")) {
              for (const [ordinal, local] of record.childLocals.entries()) {
                const child = state.nodes.get(local);
                if (child !== undefined) yield defineEdge({ name: edgeName, role: "child", from: node, to: child.snapshot.id, ordinal });
              }
            }
            if (
              state.container !== undefined &&
              (record.snapshot.kind === "markdown::document" || record.snapshot.kind === "markdown::code-block") &&
              wants(request, "markdown::container", "reference")
            ) {
              yield defineEdge({ name: "markdown::container", role: "reference", from: node, to: state.container.id, ordinal: 0 });
            }
          } else {
            for (const name of ["markdown::children", "markdown::sections"] as const) {
              const parent = record.parentByEdge[name];
              if (
                parent === undefined ||
                (request.names !== undefined && !request.names.includes(name)) ||
                (request.roles !== undefined && !request.roles.includes("child"))
              ) continue;
              const parentRecord = state.nodes.get(parent);
              if (parentRecord !== undefined) yield defineEdge({ name, role: "child", from: parentRecord.snapshot.id, to: node, ordinal: parentRecord.childLocals.indexOf(node.local) });
            }
          }
        },
      };
    },
    async hydrate(ids, projection: AttributeProjection) {
      const result: NodeSnapshot[] = [];
      for (const id of ids) {
        throwIfAborted(projection.signal);
        const record = id.adapter === "markdown" ? resources.get(id.resource)?.nodes.get(id.local) : undefined;
        if (record !== undefined) result.push(record.snapshot);
      }
      return Object.freeze(result);
    },
  };

  const planning: PlanningCapability<MarkdownOperation, MarkdownChange> = {
    async plan(operation, context) {
      throwIfAborted(context.signal);
      const state = stateFor(operation.resource);
      const record = state.nodes.get(operation.target.local);
      if (record === undefined) throw new TypeError(`Unknown Markdown target ${operation.target.local}.`);
      const actualRevision = revisionOf(await lstat(state.path));
      if (
        actualRevision !== state.resource.revision ||
        (operation.expectedRevision !== undefined && operation.expectedRevision !== actualRevision)
      ) {
        diagnostics.push(defineDiagnostic({
          code: "markdown.revision-conflict",
          severity: "error",
          message: `Markdown source ${state.resource.uri} changed after observation.`,
          locations: [{
            kind: "node",
            node: operation.target,
            ...(record.snapshot.origin === undefined ? {} : { origin: record.snapshot.origin }),
          }],
        }));
        return [];
      }
      const selected = operation.kind === "markdown::set-heading" ? record.titleRange : record.bodyRange;
      if (selected === undefined) throw new TypeError("Markdown operation target has no editable source range.");
      const replacement = operation.kind === "markdown::set-heading"
        ? operation.payload.title
        : operation.payload.content;
      const patched = `${state.text.slice(0, selected.start)}${replacement}${state.text.slice(selected.end)}`;
      const original = `${state.bom ? "\uFEFF" : ""}${state.text}`;
      const content = `${state.bom ? "\uFEFF" : ""}${patched}`;
      const payload: MarkdownPatchPayload = immutableCopy({
        uri: state.resource.uri,
        encoding: state.bom ? "utf8-bom" : "utf8",
        range: selected,
        replacement: operation.kind === "markdown::set-heading" && replacement === record.snapshot.attributes.title
          ? state.text.slice(selected.start, selected.end)
          : replacement,
        original,
        content: operation.kind === "markdown::set-heading" && replacement === record.snapshot.attributes.title
          ? original
          : content,
        formatting: "Only the semantic source range is replaced; all unrelated Markdown bytes are retained.",
      });
      const precondition: MarkdownPrecondition = {
        resource: state.resource.id,
        uri: state.resource.uri,
        expectedRevision: actualRevision,
        expectation: "exists",
        description: "Markdown source must retain its observed filesystem revision.",
      };
      const change: MarkdownChange = immutableCopy({
        adapter: "markdown",
        resource: state.resource.id,
        resourceUri: state.resource.uri,
        resourceRevision: actualRevision,
        kind: operation.kind,
        risk: "destructive",
        summary: operation.kind === "markdown::set-heading"
          ? `Set Markdown heading ${operation.target.local}`
          : `Replace Markdown section body ${operation.target.local}`,
        reversible: true,
        payload,
        preconditions: [precondition],
        regions: [{ uri: state.resource.uri, range: selected }],
        preview: { kind: "text", uri: state.resource.uri, before: original, after: payload.content, sensitive: true },
        transaction: { key: state.resource.uri, atomic: true, rollback: "none", compensation: "none" },
      });
      return Object.freeze([change]);
    },
  };

  const apply: ApplyCapability<MarkdownChange, ApplyResult> = {
    async apply(changes, context) {
      throwIfAborted(context.signal);
      const first = changes[0];
      if (first === undefined) return Object.freeze({ applied: 0, diagnostics: Object.freeze([]) });
      if (changes.some((change) => change.payload.uri !== first.payload.uri || change.payload.original !== first.payload.original)) {
        throw new TypeError("Atomic Markdown changes must share one observed document.");
      }
      const path = fileURLToPath(first.payload.uri);
      const stat = await lstat(path);
      const revision = revisionOf(stat);
      if (changes.some((change) => change.preconditions.some((precondition) => precondition.expectedRevision !== revision))) {
        throw new Error(`Markdown revision changed for ${first.payload.uri}.`);
      }
      const current = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(path));
      if (current !== first.payload.original) throw new Error(`Markdown content changed for ${first.payload.uri}.`);
      const bom = current.startsWith("\uFEFF");
      let text = bom ? current.slice(1) : current;
      const ordered = [...changes].toSorted((left, right) => right.payload.range.start - left.payload.range.start);
      let previous = Number.POSITIVE_INFINITY;
      for (const change of ordered) {
        if (change.payload.range.end > previous) throw new Error("Markdown change patches overlap.");
        text = `${text.slice(0, change.payload.range.start)}${change.payload.replacement}${text.slice(change.payload.range.end)}`;
        previous = change.payload.range.start;
      }
      const temporary = join(dirname(path), `.${basename(path)}.ast-${randomUUID()}`);
      try {
        await writeFile(temporary, `${bom ? "\uFEFF" : ""}${text}`, { mode: stat.mode });
        throwIfAborted(context.signal);
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return Object.freeze({ applied: changes.length, diagnostics: Object.freeze([]) });
    },
  };

  const mount: MountCapability = {
    edge: "markdown::mount",
    open(container, source, context) {
      return load(source.uri, "markdown::syntax-tree", container, context);
    },
  };
  const adapter = Object.freeze({
    contractVersion: "1" as const,
    namespace: "markdown" as const,
    schema,
    read,
    planning,
    apply,
    mount,
    diagnostics: () => Object.freeze([...diagnostics]),
    statistics: () => Object.freeze({ ...statistics }),
    mountedJson: options.json,
  });
  internals.set(adapter, {
    openMounted(container, treeView, context) {
      if (container.kind !== "fs::file" || container.origin?.uri === undefined) {
        throw new TypeError("Markdown mounts require an fs::file with source provenance.");
      }
      return load(container.origin.uri, treeView, container, context);
    },
  });
  return adapter;
};

export const fromMarkdown = (
  adapter: MarkdownAdapter,
  source: MarkdownSource,
): Query<NavigableNodeHandle> =>
  fromValues(
    (options) => ({
      async *[Symbol.asyncIterator]() {
        const descriptor: SourceDescriptor = {
          uri: source.uri,
          ...(source.treeView === undefined ? {} : { treeView: source.treeView }),
        };
        const handle = await adapter.read.open(
          descriptor,
          options.signal === undefined ? {} : { signal: options.signal },
        );
        try {
          for await (const root of adapter.read.roots(handle.resource, options.signal === undefined ? {} : { signal: options.signal })) {
            yield markdownHandle(adapter, root, undefined, (adapter as MarkdownAdapter & { readonly mountedJson?: JsonAdapter }).mountedJson);
          }
        } finally {
          await handle.close();
        }
      },
    }),
    { ordering: "stable", label: "markdown", details: { uri: source.uri, treeView: source.treeView ?? "markdown::syntax-tree" } },
  );
