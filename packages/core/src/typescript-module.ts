import * as ts from "typescript";
import { pathToFileURL } from "node:url";
import { immutableCopy } from "./immutable.js";
import type { Origin, Resource } from "./model.js";

/** A static import or re-export as written in a module. */
export interface TypeScriptModuleImport {
  readonly kind: "import" | "re-export" | "import-equals";
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly origin: Origin;
  /** Present only when the configured compiler resolves this module. */
  readonly resolvedUri?: string;
}

/** An externally visible name and its declaration, when known. */
export interface TypeScriptModuleExport {
  readonly name: string;
  readonly localName?: string;
  readonly typeOnly: boolean;
  readonly declarationKind?: string;
  readonly origin: Origin;
  /** Exact JSDoc blocks on the declaration, including tags. */
  readonly documentation?: string;
}

export interface TypeScriptModuleInfo {
  readonly resource: Resource;
  readonly mode: "syntax-only" | "configured-project";
  readonly imports: readonly TypeScriptModuleImport[];
  readonly exports: readonly TypeScriptModuleExport[];
}

const originFor = (node: ts.Node, resources: ReadonlyMap<ts.SourceFile, Resource>): Origin => {
  const source = node.getSourceFile();
  const uri = pathToFileURL(source.fileName).href;
  const start = node.getStart(source);
  const first = source.getLineAndCharacterOfPosition(start);
  const last = source.getLineAndCharacterOfPosition(node.end);
  const revision = resources.get(source)?.revision;
  return { uri, ...(revision === undefined ? {} : { revision }), range: {
    start, end: node.end, startLine: first.line, startColumn: first.character,
    endLine: last.line, endColumn: last.character,
  } };
};

const documentationFor = (node: ts.Node): string | undefined => {
  let blocks = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
  while (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) node = node.parent;
  if (blocks.length === 0 && ts.isVariableDeclaration(node)) blocks = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
  if (blocks.length === 0 && ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent)) {
    blocks = ts.getJSDocCommentsAndTags(node.parent.parent).filter(ts.isJSDoc);
  }
  return blocks.length === 0 ? undefined : blocks.map(block => block.getText()).join("\n");
};

const hasModifier = (node: ts.Node, flag: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(modifier => modifier.kind === flag) ?? false);

const bindingNames = (name: ts.BindingName): readonly ts.Identifier[] =>
  ts.isIdentifier(name) ? [name] : name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));

const declarationNames = (statement: ts.Statement): readonly { name: string; node: ts.Node }[] => {
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap(node => bindingNames(node.name).map(name => ({ name: name.text, node })));
  const name = ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement) || ts.isImportEqualsDeclaration(statement) ? statement.name : undefined;
  return name !== undefined && ts.isIdentifier(name) ? [{ name: name.text, node: statement }] : [];
};

/** Follow authored export routes using only the captured compiler graph. */
const typeOnlyResolver = (checker: ts.TypeChecker): {
  readonly exported: (source: ts.SourceFile, name: string) => boolean | undefined;
  readonly symbol: (symbol: ts.Symbol) => boolean | undefined;
} => {
  const tables = new Map<ts.SourceFile, ReadonlyMap<string, ts.Symbol>>();
  const active = new Map<ts.SourceFile, Set<string>>();
  const aliases = new Set<ts.Symbol>();
  const table = (source: ts.SourceFile): ReadonlyMap<string, ts.Symbol> => {
    let found = tables.get(source);
    if (!found) {
      const module = checker.getSymbolAtLocation(source);
      found = new Map(module ? checker.getExportsOfModule(module).map(symbol => [symbol.name, symbol]) : []);
      tables.set(source, found);
    }
    return found;
  };
  const moduleSource = (specifier: ts.Node): ts.SourceFile | undefined => checker.getSymbolAtLocation(specifier)?.declarations?.find(ts.isSourceFile);
  const symbolTypeOnly = (symbol: ts.Symbol): boolean | undefined => {
    if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return (symbol.flags & ts.SymbolFlags.Value) === 0;
    if (aliases.has(symbol)) return undefined;
    aliases.add(symbol);
    try {
      for (const declaration of symbol.declarations ?? []) {
        if (ts.isTypeOnlyImportOrExportDeclaration(declaration)) return true;
        let imported: ts.ImportDeclaration | ts.JSDocImportTag | undefined;
        let name: string | undefined;
        if (ts.isImportSpecifier(declaration)) {
          imported = declaration.parent.parent.parent;
          name = (declaration.propertyName ?? declaration.name).text;
        } else if (ts.isImportClause(declaration)) {
          imported = declaration.parent;
          name = "default";
        } else if (ts.isNamespaceImport(declaration) || ts.isNamespaceExport(declaration)) return false;
        if (imported && name !== undefined) {
          const remote = moduleSource(imported.moduleSpecifier);
          const result = remote && exported(remote, name);
          if (result !== undefined) return result;
        }
        if (ts.isExportSpecifier(declaration) && declaration.parent.parent.moduleSpecifier) {
          const remote = moduleSource(declaration.parent.parent.moduleSpecifier);
          const result = remote && exported(remote, (declaration.propertyName ?? declaration.name).text);
          if (result !== undefined) return result;
        }
      }
      const next = checker.getImmediateAliasedSymbol(symbol);
      return next && next !== symbol ? symbolTypeOnly(next) : undefined;
    } finally { aliases.delete(symbol); }
  };
  const exported = (source: ts.SourceFile, name: string): boolean | undefined => {
    const symbol = table(source).get(name);
    if (!symbol) return undefined;
    let names = active.get(source);
    if (!names) { names = new Set(); active.set(source, names); }
    if (names.has(name)) return undefined;
    names.add(name);
    try {
      // Explicit exports take precedence over wildcard routes.
      for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement) && statement.exportClause) {
          if (ts.isNamespaceExport(statement.exportClause)) {
            if (statement.exportClause.name.text === name) return statement.isTypeOnly;
          } else for (const element of statement.exportClause.elements) {
            if (element.name.text !== name) continue;
            if (statement.isTypeOnly || element.isTypeOnly) return true;
            const remote = statement.moduleSpecifier && moduleSource(statement.moduleSpecifier);
            return remote ? exported(remote, (element.propertyName ?? element.name).text) : symbolTypeOnly(symbol);
          }
        } else if ((hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
          (hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? name === "default" : declarationNames(statement).some(item => item.name === name))) ||
          (ts.isExportAssignment(statement) && !statement.isExportEquals && name === "default")) return symbolTypeOnly(symbol);
      }
      const routes: boolean[] = [];
      for (const statement of source.statements) {
        if (!ts.isExportDeclaration(statement) || statement.exportClause || !statement.moduleSpecifier || name === "default") continue;
        const remote = moduleSource(statement.moduleSpecifier);
        if (!remote || !table(remote).has(name)) continue;
        const route = statement.isTypeOnly ? true : exported(remote, name);
        if (route !== undefined) routes.push(route);
      }
      return routes.length ? routes.every(Boolean) : symbolTypeOnly(symbol);
    } finally { names.delete(name); }
  };
  return { exported, symbol: symbolTypeOnly };
};

/** Internal compiler projection shared by syntax-only and configured adapters. */
export const moduleInfoFor = (
  source: ts.SourceFile,
  resource: Resource,
  resources: ReadonlyMap<ts.SourceFile, Resource>,
  checker: ts.TypeChecker | undefined,
  syntaxChecker: () => ts.TypeChecker,
): TypeScriptModuleInfo => {
  const configuredTypeOnly = checker && typeOnlyResolver(checker);
  const typeOnlyDeclaration = (node: ts.Node): boolean => {
    if (ts.isTypeAliasDeclaration(node)) return true;
    if (!ts.isInterfaceDeclaration(node) && !ts.isModuleDeclaration(node)) return false;
    const symbol = (checker ?? syntaxChecker()).getSymbolAtLocation(node.name);
    return symbol === undefined ? ts.isInterfaceDeclaration(node) : (symbol.flags & ts.SymbolFlags.Value) === 0;
  };
  const imports: TypeScriptModuleImport[] = [];
  const exports = new Map<string, TypeScriptModuleExport>();
  const addSyntaxExport = (name: string, entry: TypeScriptModuleExport): void => {
    if (!exports.has(name)) exports.set(name, entry);
  };
  const explicitExports = new Map<string, boolean>();
  const typeStars = new Set<string>();
  const valueStars = new Set<string>();
  const typeOnlyLocals = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause) {
      const clause = statement.importClause;
      if (clause.isTypeOnly && clause.name) typeOnlyLocals.add(clause.name.text);
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          if (clause.isTypeOnly) typeOnlyLocals.add(clause.namedBindings.name.text);
        } else for (const element of clause.namedBindings.elements) if (clause.isTypeOnly || element.isTypeOnly) typeOnlyLocals.add(element.name.text);
      }
    } else if (ts.isImportEqualsDeclaration(statement) && statement.isTypeOnly) typeOnlyLocals.add(statement.name.text);
  }
  const locals = new Map<string, ts.Node>();
  for (const item of source.statements.flatMap(declarationNames)) if (!locals.has(item.name)) locals.set(item.name, item.node);
  const exportEntry = (name: string, node: ts.Node, typeOnly: boolean, localName?: string): TypeScriptModuleExport => {
    const documentation = documentationFor(node);
    return { name, typeOnly, ...(localName === undefined ? {} : { localName }), declarationKind: ts.SyntaxKind[node.kind], origin: originFor(node, resources), ...(documentation === undefined ? {} : { documentation }) };
  };
  for (const statement of source.statements) {
    let specifier: ts.Expression | undefined;
    let kind: TypeScriptModuleImport["kind"] = "import";
    let typeOnly = false;
    if (ts.isImportDeclaration(statement)) {
      specifier = statement.moduleSpecifier;
      typeOnly = statement.importClause?.isTypeOnly ?? false;
      const bindings = statement.importClause?.namedBindings;
      if (!statement.importClause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0) typeOnly ||= bindings.elements.every(element => element.isTypeOnly);
    } else if (ts.isExportDeclaration(statement)) {
      specifier = statement.moduleSpecifier; kind = "re-export"; typeOnly = statement.isTypeOnly;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.length > 0) typeOnly ||= statement.exportClause.elements.every(element => element.isTypeOnly);
      if (statement.exportClause) {
        if (ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) explicitExports.set(element.name.text, statement.isTypeOnly || element.isTypeOnly || (!statement.moduleSpecifier && typeOnlyLocals.has((element.propertyName ?? element.name).text)));
        else explicitExports.set(statement.exportClause.name.text, statement.isTypeOnly);
      } else if (checker && statement.moduleSpecifier) {
        const module = checker.getSymbolAtLocation(statement.moduleSpecifier);
        if (module) for (const symbol of checker.getExportsOfModule(module)) if (symbol.name !== "default") (statement.isTypeOnly ? typeStars : valueStars).add(symbol.name);
      }
    } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
      specifier = statement.moduleReference.expression; kind = "import-equals"; typeOnly = statement.isTypeOnly;
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const resolved = checker?.getSymbolAtLocation(specifier)?.declarations?.find(ts.isSourceFile);
      imports.push({ kind, specifier: specifier.text, typeOnly, origin: originFor(statement, resources), ...(resolved === undefined ? {} : { resolvedUri: pathToFileURL(resolved.fileName).href }) });
    }
    if (checker !== undefined) {
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword) && !ts.isExportDeclaration(statement)) {
        if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) explicitExports.set("default", false);
        else for (const item of declarationNames(statement)) explicitExports.set(item.name, typeOnlyLocals.has(item.name));
      }
      continue;
    }
    if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
      const names = declarationNames(statement);
      if (isDefault) addSyntaxExport("default", exportEntry("default", statement, typeOnlyDeclaration(statement), names[0]?.name));
      else for (const item of names) addSyntaxExport(item.name, exportEntry(item.name, item.node, typeOnlyDeclaration(item.node) || typeOnlyLocals.has(item.name), item.name));
    }
    if (ts.isExportAssignment(statement)) {
      const name = statement.isExportEquals ? "export=" : "default";
      const localName = ts.isIdentifier(statement.expression) ? statement.expression.text : undefined;
      const declaration = localName === undefined ? undefined : locals.get(localName);
      addSyntaxExport(name, exportEntry(name, declaration ?? statement, (localName !== undefined && typeOnlyLocals.has(localName)) || (declaration !== undefined && typeOnlyDeclaration(declaration)), localName));
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) {
        const localName = (element.propertyName ?? element.name).text;
        const declaration = statement.moduleSpecifier ? undefined : locals.get(localName);
        addSyntaxExport(element.name.text, exportEntry(element.name.text, declaration ?? element, statement.isTypeOnly || element.isTypeOnly || (!statement.moduleSpecifier && typeOnlyLocals.has(localName)) || (declaration !== undefined && typeOnlyDeclaration(declaration)), localName));
      }
      else addSyntaxExport(statement.exportClause.name.text, exportEntry(statement.exportClause.name.text, statement.exportClause, statement.isTypeOnly));
    }
  }
  const moduleSymbol = checker?.getSymbolAtLocation(source);
  const exportEquals = source.statements.find((node): node is ts.ExportAssignment => ts.isExportAssignment(node) && node.isExportEquals === true);
  if (exportEquals) {
    const expression = exportEquals.expression;
    const symbol = checker?.getSymbolAtLocation(expression);
    const target = symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker?.getAliasedSymbol(symbol) : symbol;
    const declaration = target?.declarations?.[0] ?? (ts.isIdentifier(expression) ? locals.get(expression.text) : undefined) ?? exportEquals;
    exports.clear();
    const explicitType = ts.isIdentifier(expression) && typeOnlyLocals.has(expression.text);
    const typeOnly = explicitType || ((symbol === undefined ? undefined : configuredTypeOnly?.symbol(symbol)) ?? typeOnlyDeclaration(declaration));
    exports.set("export=", exportEntry("export=", declaration, typeOnly, ts.isIdentifier(expression) ? expression.text : undefined));
  }
  if (!exportEquals && checker && moduleSymbol) for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
    const declaration = target.declarations?.[0] ?? symbol.declarations?.[0];
    if (!declaration) continue;
    const explicitType = explicitExports.get(symbol.name) ?? (typeStars.has(symbol.name) && !valueStars.has(symbol.name));
    const declaredName = (declaration as ts.NamedDeclaration).name;
    const localName = declaredName && ts.isIdentifier(declaredName) ? declaredName.text : undefined;
    const typeOnly = configuredTypeOnly?.exported(source, symbol.name) ?? (explicitType || (target.flags & ts.SymbolFlags.Value) === 0);
    exports.set(symbol.name, exportEntry(symbol.name, declaration, typeOnly, localName));
  }
  return immutableCopy({ resource, mode: checker === undefined ? "syntax-only" : "configured-project", imports, exports: [...exports.values()] });
};
