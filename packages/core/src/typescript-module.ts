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
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap(node => bindingNames(node.name).map(name => ({ name: name.text, node: name.parent })));
  const name = ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement) || ts.isImportEqualsDeclaration(statement) ? statement.name : undefined;
  return name !== undefined && ts.isIdentifier(name) ? [{ name: name.text, node: statement }] : [];
};

const localExportName = (symbol: ts.Symbol): string | undefined => {
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isExportAssignment(declaration) && ts.isIdentifier(declaration.expression)) return declaration.expression.text;
    if (ts.isExportSpecifier(declaration) && !declaration.parent.parent.moduleSpecifier) return (declaration.propertyName ?? declaration.name).text;
    if (ts.isImportEqualsDeclaration(declaration)) return declaration.name.text;
  }
  return undefined;
};

/** Follow authored export routes using only the captured compiler graph. */
const typeOnlyResolver = (checker: ts.TypeChecker): {
  readonly exported: (source: ts.SourceFile, name: string) => boolean | undefined;
  readonly symbol: (symbol: ts.Symbol) => boolean | undefined;
} => {
  interface Route {
    readonly value?: boolean;
    readonly dependencies: () => readonly Route[];
  }
  const type: Route = { value: true, dependencies: () => [] };
  const value: Route = { value: false, dependencies: () => [] };
  const tables = new Map<ts.Symbol, ReadonlyMap<string, ts.Symbol>>();
  const modules = new Map<ts.Symbol, Map<string, Route>>();
  const symbols = new Map<ts.Symbol, Route>();
  const edges = new Map<Route, readonly Route[]>();
  const results = new Map<Route, boolean | undefined>();
  const table = (module: ts.Symbol): ReadonlyMap<string, ts.Symbol> => {
    let found = tables.get(module);
    if (!found) {
      found = new Map(checker.getExportsOfModule(module).map(symbol => [symbol.name, symbol]));
      tables.set(module, found);
    }
    return found;
  };
  const moduleSymbol = (specifier: ts.Node): ts.Symbol | undefined => checker.getSymbolAtLocation(specifier);
  const symbolRoute = (symbol: ts.Symbol): Route => {
    if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return (symbol.flags & ts.SymbolFlags.Value) === 0 ? type : value;
    let found = symbols.get(symbol);
    if (!found) {
      found = { dependencies: () => {
        for (const declaration of symbol.declarations ?? []) {
          if (ts.isTypeOnlyImportOrExportDeclaration(declaration)) return [type];
          let imported: ts.ImportDeclaration | ts.JSDocImportTag | undefined;
          let name: string | undefined;
          if (ts.isImportSpecifier(declaration)) {
            imported = declaration.parent.parent.parent;
            name = (declaration.propertyName ?? declaration.name).text;
          } else if (ts.isImportClause(declaration)) {
            imported = declaration.parent;
            name = "default";
          } else if (ts.isNamespaceImport(declaration) || ts.isNamespaceExport(declaration)) return [value];
          if (imported && name !== undefined) {
            const remote = moduleSymbol(imported.moduleSpecifier);
            if (remote && table(remote).has(name)) return [exportRoute(remote, name)];
          }
          if (ts.isExportSpecifier(declaration) && declaration.parent.parent.moduleSpecifier) {
            const remote = moduleSymbol(declaration.parent.parent.moduleSpecifier);
            const remoteName = (declaration.propertyName ?? declaration.name).text;
            if (remote && table(remote).has(remoteName)) return [exportRoute(remote, remoteName)];
          }
        }
        const next = checker.getImmediateAliasedSymbol(symbol);
        return next && next !== symbol ? [symbolRoute(next)] : [];
      } };
      symbols.set(symbol, found);
    }
    return found;
  };
  const exportRoute = (module: ts.Symbol, name: string): Route => {
    let names = modules.get(module);
    if (!names) { names = new Map(); modules.set(module, names); }
    let found = names.get(name);
    if (!found) {
      found = { dependencies: () => {
        const symbol = table(module).get(name);
        if (!symbol) return [];
        const statements = (module.declarations ?? []).flatMap(declaration =>
          ts.isSourceFile(declaration) ? declaration.statements
            : ts.isModuleDeclaration(declaration) && declaration.body && ts.isModuleBlock(declaration.body) ? declaration.body.statements : []);
        // Explicit exports take precedence over wildcard routes.
        for (const statement of statements) {
          if (ts.isExportDeclaration(statement) && statement.exportClause) {
            if (ts.isNamespaceExport(statement.exportClause)) {
              if (statement.exportClause.name.text === name) return [statement.isTypeOnly ? type : value];
            } else for (const element of statement.exportClause.elements) {
              if (element.name.text !== name) continue;
              if (statement.isTypeOnly || element.isTypeOnly) return [type];
              const remote = statement.moduleSpecifier && moduleSymbol(statement.moduleSpecifier);
              return [remote ? exportRoute(remote, (element.propertyName ?? element.name).text) : symbolRoute(symbol)];
            }
          } else if ((hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
            (hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? name === "default" : declarationNames(statement).some(item => item.name === name))) ||
            (ts.isExportAssignment(statement) && !statement.isExportEquals && name === "default")) return [symbolRoute(symbol)];
        }
        const routes: Route[] = [];
        for (const statement of statements) {
          if (!ts.isExportDeclaration(statement) || statement.exportClause || !statement.moduleSpecifier || name === "default") continue;
          const remote = moduleSymbol(statement.moduleSpecifier);
          if (remote && table(remote).has(name)) routes.push(statement.isTypeOnly ? type : exportRoute(remote, name));
        }
        return routes.length ? routes : [symbolRoute(symbol)];
      } };
      names.set(name, found);
    }
    return found;
  };
  const resolve = (root: Route): boolean | undefined => {
    if (results.has(root)) return results.get(root);
    const indices = new Map<Route, number>();
    const low = new Map<Route, number>();
    const stack: Route[] = [];
    const active = new Set<Route>();
    const visit = (node: Route): void => {
      const index = indices.size;
      indices.set(node, index); low.set(node, index);
      stack.push(node); active.add(node);
      const dependencies = node.dependencies();
      edges.set(node, dependencies);
      for (const dependency of dependencies) {
        if (results.has(dependency)) continue;
        if (!indices.has(dependency)) {
          visit(dependency);
          low.set(node, Math.min(low.get(node)!, low.get(dependency)!));
        } else if (active.has(dependency)) low.set(node, Math.min(low.get(node)!, indices.get(dependency)!));
      }
      if (low.get(node) !== index) return;
      const component = new Set<Route>();
      let member: Route;
      do { member = stack.pop()!; active.delete(member); component.add(member); } while (member !== node);
      let result: boolean | undefined;
      const include = (next: boolean | undefined): void => {
        if (next !== undefined) result = result === undefined ? next : result && next;
      };
      // All members of a cycle share their terminating routes. Unknown cycles
      // supply no value; any proven value route overrides type-only routes.
      for (const item of component) {
        include(item.value);
        for (const dependency of edges.get(item)!) if (!component.has(dependency)) include(results.get(dependency));
      }
      for (const item of component) results.set(item, result);
    };
    visit(root);
    return results.get(root);
  };
  return {
    exported: (source, name) => {
      const module = checker.getSymbolAtLocation(source);
      return module && resolve(exportRoute(module, name));
    },
    symbol: symbol => resolve(symbolRoute(symbol)),
  };
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
    if (ts.isImportEqualsDeclaration(node) && !ts.isExternalModuleReference(node.moduleReference)) {
      const localChecker = checker ?? syntaxChecker();
      const symbol = localChecker.getSymbolAtLocation(node.name);
      return symbol !== undefined && (typeOnlyResolver(localChecker).symbol(symbol) ?? false);
    }
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
      const declarations = checker?.getSymbolAtLocation(specifier)?.declarations;
      const resolved = declarations?.find(ts.isSourceFile) ?? declarations?.find(ts.isModuleDeclaration)?.getSourceFile();
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
    const declaredName = ts.isNamespaceExport(declaration) ? undefined
      : ts.isExportSpecifier(declaration) ? declaration.propertyName ?? declaration.name
      : (declaration as ts.NamedDeclaration).name;
    const localName = declaredName && ts.isIdentifier(declaredName) ? declaredName.text : localExportName(symbol);
    const typeOnly = configuredTypeOnly?.exported(source, symbol.name) ?? (explicitType || (target.flags & ts.SymbolFlags.Value) === 0);
    exports.set(symbol.name, exportEntry(symbol.name, declaration, typeOnly, localName));
  }
  return immutableCopy({ resource, mode: checker === undefined ? "syntax-only" : "configured-project", imports, exports: [...exports.values()] });
};
