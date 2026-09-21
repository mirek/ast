/// <reference lib="dom" />
/// <reference types="emscripten" />
import type { WasmNode, WasmTree } from "@xberg-io/tree-sitter-language-pack-wasm";
import { fileURLToPath } from "node:url";
import type { TreeSitterGrammar } from "./treesitter.js";

interface Point { readonly row: number; readonly column: number }
export interface SyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly isNamed: boolean;
  readonly isMissing: boolean;
  readonly isError: boolean;
  readonly hasError: boolean;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: Point;
  readonly endPosition: Point;
  readonly childCount: number;
  child(index: number): SyntaxNode | null;
  fieldNameForChild(index: number): string | null;
}
export interface SyntaxTree {
  readonly rootNode: SyntaxNode;
  delete(): void;
}

// The language pack uses byte offsets; the graph exposes UTF-16 consistently
// with the JS text and the existing document adapters.
const wrapPackTree = (tree: WasmTree, text: string): SyntaxTree => {
  const offsets = new Uint32Array(Buffer.byteLength(text) + 1);
  let byte = 0;
  let unit = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character);
    for (let offset = 0; offset < width; offset += 1) offsets[byte + offset] = unit;
    byte += width;
    unit += character.length;
  }
  offsets[byte] = unit;
  const lines = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") lines.push(index + 1);
  const position = (index: number): Point => {
    let low = 0;
    let high = lines.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lines[middle]! <= index) low = middle; else high = middle;
    }
    return { row: low, column: index - lines[low]! };
  };
  const owned: WasmNode[] = [];
  const wrap = (node: WasmNode): SyntaxNode => {
    owned.push(node);
    const children = new Map<number, SyntaxNode | null>();
    let fields: readonly (string | null)[] | undefined;
    return {
      get type() { return node.kind(); },
      get text() { return text.slice(offsets[node.startByte()]!, offsets[node.endByte()]!); },
      get isNamed() { return node.isNamed(); },
      get isMissing() { return node.isMissing(); },
      get isError() { return node.isError(); },
      get hasError() { return node.hasError(); },
      get startIndex() { return offsets[node.startByte()]!; },
      get endIndex() { return offsets[node.endByte()]!; },
      get startPosition() { return position(offsets[node.startByte()]!); },
      get endPosition() { return position(offsets[node.endByte()]!); },
      get childCount() { return node.childCount(); },
      child(index) {
        if (!children.has(index)) {
          const child = node.child(index);
          children.set(index, child ? wrap(child) : null);
        }
        return children.get(index)!;
      },
      fieldNameForChild(index) {
        if (!fields) {
          const cursor = node.walk();
          const names: (string | null)[] = [];
          try {
            if (cursor.gotoFirstChild()) do { names.push(cursor.fieldName() ?? null); } while (cursor.gotoNextSibling());
          } finally { cursor.free(); }
          fields = names;
        }
        return fields[index] ?? null;
      },
    };
  };
  const rootNode = wrap(tree.rootNode());
  return { rootNode, delete() {
    for (const node of owned) node.free();
    owned.length = 0;
    tree.free();
  } };
};

let webInitialization: Promise<void> | undefined;

/** One private loader cache per adapter. Trees remain per-resource leases. */
export const createSyntaxParser = () => {
  const languages = new Map<string, Promise<import("web-tree-sitter").Language>>();
  return async (grammar: TreeSitterGrammar, text: string, signal?: AbortSignal): Promise<SyntaxTree> => {
    signal?.throwIfAborted();
    if (grammar.wasm === undefined) {
      const pack = await import("@xberg-io/tree-sitter-language-pack-wasm");
      signal?.throwIfAborted();
      const parser = pack.getParser(grammar.name);
      let tree: WasmTree | undefined;
      try {
        tree = parser.parse(text) ?? undefined;
        signal?.throwIfAborted();
        if (!tree) throw new Error(`Tree-sitter parsing failed for ${grammar.name}.`);
        return wrapPackTree(tree, text);
      } catch (error) { tree?.free(); throw error; }
      finally { parser.free(); }
    }
    const { Parser, Language } = await import("web-tree-sitter");
    webInitialization ??= Parser.init();
    await webInitialization;
    signal?.throwIfAborted();
    let loading = languages.get(grammar.wasm);
    if (!loading) {
      const path = grammar.wasm.startsWith("file:") ? fileURLToPath(grammar.wasm) : grammar.wasm;
      loading = Language.load(path);
      languages.set(grammar.wasm, loading);
    }
    const language = await loading;
    signal?.throwIfAborted();
    const parser = new Parser();
    let tree: import("web-tree-sitter").Tree | null = null;
    try {
      parser.setLanguage(language);
      tree = parser.parse(text, null, { progressCallback: () => signal?.throwIfAborted() });
      signal?.throwIfAborted();
      if (!tree) throw new Error(`Tree-sitter parsing failed for ${grammar.name}.`);
      return tree;
    } catch (error) { tree?.delete(); throw error; }
    finally { parser.delete(); }
  };
};
