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

/** Internal compiler projection shared by syntax-only and configured adapters. */
export const moduleInfoFor = (
  source: ts.SourceFile,
  resource: Resource,
  resources: ReadonlyMap<ts.SourceFile, Resource>,
  checker: ts.TypeChecker | undefined,
): TypeScriptModuleInfo => {
  const imports: TypeScriptModuleImport[] = [];
  const exports = new Map<string, TypeScriptModuleExport>();
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
  const locals = new Map(source.statements.flatMap(declarationNames).map(item => [item.name, item.node]));
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
        else for (const item of declarationNames(statement)) explicitExports.set(item.name, false);
      }
      continue;
    }
    if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
      const names = declarationNames(statement);
      if (isDefault) exports.set("default", exportEntry("default", statement, ts.isInterfaceDeclaration(statement), names[0]?.name));
      else for (const item of names) exports.set(item.name, exportEntry(item.name, item.node, ts.isInterfaceDeclaration(item.node) || ts.isTypeAliasDeclaration(item.node) || typeOnlyLocals.has(item.name), item.name));
    }
    if (ts.isExportAssignment(statement)) {
      const name = statement.isExportEquals ? "export=" : "default";
      exports.set(name, exportEntry(name, statement, false));
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) {
        const localName = (element.propertyName ?? element.name).text;
        const declaration = statement.moduleSpecifier ? undefined : locals.get(localName);
        exports.set(element.name.text, exportEntry(element.name.text, declaration ?? element, statement.isTypeOnly || element.isTypeOnly || (!statement.moduleSpecifier && typeOnlyLocals.has(localName)) || (declaration !== undefined && (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration))), localName));
      }
      else exports.set(statement.exportClause.name.text, exportEntry(statement.exportClause.name.text, statement.exportClause, statement.isTypeOnly));
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
    exports.set("export=", exportEntry("export=", declaration, ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration), ts.isIdentifier(expression) ? expression.text : undefined));
  }
  if (!exportEquals && checker && moduleSymbol) for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
    const declaration = target.declarations?.[0] ?? symbol.declarations?.[0];
    if (!declaration) continue;
    const explicitType = explicitExports.get(symbol.name) ?? (typeStars.has(symbol.name) && !valueStars.has(symbol.name));
    const declaredName = (declaration as ts.NamedDeclaration).name;
    const localName = declaredName && ts.isIdentifier(declaredName) ? declaredName.text : undefined;
    exports.set(symbol.name, exportEntry(symbol.name, declaration, explicitType || (target.flags & ts.SymbolFlags.Value) === 0, localName));
  }
  return immutableCopy({ resource, mode: checker === undefined ? "syntax-only" : "configured-project", imports, exports: [...exports.values()] });
};
