import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createFilesystemAdapter, createJsonAdapter, createMarkdownAdapter,
  createTypeScriptAdapter, createTreeSitterAdapter, fromFilesystem,
  mountJson, mountMarkdown, mountTypeScript, mountTreeSitter, selectFrom,
} from '@mirek/ast';

const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'ast-mount-navigation-'));
  try { await mkdir(join(root, 'pkg')); await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
};
const formats = [
  { create: createJsonAdapter, mount: mountJson, name: 'data.json', text: '{"name":"demo"}', root: 'json::root', leaf: 'json::scalar', edge: 'json::container' },
  { create: createMarkdownAdapter, mount: mountMarkdown, name: 'README.md', text: '# Demo\n', root: 'markdown::document', leaf: 'markdown::heading', edge: 'markdown::container' },
  { create: createTypeScriptAdapter, mount: mountTypeScript, name: 'main.ts', text: 'function demo() {}\n', root: 'ts::source-file', leaf: 'ts::function', edge: 'ts::container' },
  { create: createTreeSitterAdapter, mount: mountTreeSitter, name: 'main.py', text: 'def demo(): pass\n', root: 'treesitter::node', leaf: 'treesitter::node[type = "function_definition"]', edge: 'treesitter::container' },
];
for (const format of formats) {
  test(`${format.root} mounts survive directory navigation and container reentry`, () => fixture(async root => {
    await writeFile(join(root, 'pkg', format.name), format.text);
    const fs = createFilesystemAdapter();
    const adapter = format.create();
    const mounted = format.mount(fromFilesystem(fs, { uri: root }), adapter);
    const schemas = [fs.schema, adapter.schema];
    const nodes = await selectFrom(mounted, schemas, `fs::directory[name = "pkg"] > fs::file > ${format.root} ${format.leaf}`).toArray();
    assert.equal(nodes.length, 1);
    const reentered = await selectFrom(mounted, schemas, `fs::file > ${format.root} ->${format.edge} fs::file > ${format.root} ${format.leaf}`).toArray();
    assert.equal(reentered.length, 1);
    assert.equal(adapter.statistics().opened, adapter.statistics().closed);
  }));
}

test('stacked mounts retain both adapters when navigating between syntax views', () => fixture(async root => {
  await writeFile(join(root, 'pkg', 'data.json'), '{"name":"demo"}');
  const fs = createFilesystemAdapter();
  const json = createJsonAdapter();
  const syntax = createTreeSitterAdapter();
  const files = fromFilesystem(fs, { uri: root });
  for (const mounted of [mountTreeSitter(mountJson(files, json), syntax), mountJson(mountTreeSitter(files, syntax), json)]) {
    const query = selectFrom(mounted, [fs.schema, json.schema, syntax.schema], 'fs::directory[name = "pkg"] > fs::file > json::root ->json::container fs::file > treesitter::node ->treesitter::container fs::file > json::root json::scalar');
    // Each nesting order exercises a different adapter's resolver delegation.
    // eslint-disable-next-line no-await-in-loop
    const nodes = await query.toArray();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].snapshot.attributes.value, 'demo');
  }
  assert.equal(json.statistics().opened, json.statistics().closed);
  assert.equal(syntax.statistics().opened, syntax.statistics().closed);
}));

test('embedded JSON retains its code-block mount and containing Markdown view', () => fixture(async root => {
  await writeFile(join(root, 'pkg', 'README.md'), '# Demo\n\n```json\n{"ok":true}\n```\n');
  const fs = createFilesystemAdapter();
  const json = createJsonAdapter();
  const markdown = createMarkdownAdapter({ json });
  const mounted = mountMarkdown(fromFilesystem(fs, { uri: root }), markdown);
  const nodes = await selectFrom(mounted, [fs.schema, markdown.schema, json.schema], 'fs::directory[name = "pkg"] > fs::file > markdown::document markdown::code-block > json::root ->json::container markdown::code-block > json::root json::scalar').toArray();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].snapshot.attributes.value, true);
  assert.equal(json.statistics().opened, json.statistics().closed);
  assert.equal(markdown.statistics().opened, markdown.statistics().closed);
}));

test('decorated directory handles keep mounts lazy and close nested queries on early return or failure', () => fixture(async root => {
  await writeFile(join(root, 'pkg', 'data.json'), '{"first":1,"second":2}');
  const fs = createFilesystemAdapter();
  const json = createJsonAdapter();
  const mounted = mountJson(fromFilesystem(fs, { uri: root }), json);
  const schema = [fs.schema, json.schema];
  const prefix = 'fs::directory[name = "pkg"] > fs::file';
  const metadata = await selectFrom(mounted, schema, prefix).toArray();
  assert.equal(metadata.length, 1);
  assert.equal(json.statistics().filesRead, 0);
  const query = selectFrom(mounted, schema, `${prefix} > json::root ->json::container fs::file > json::root json::scalar`);
  assert.equal((await query.take(1).toArray()).length, 1);
  assert.equal(json.statistics().opened, 2);
  assert.equal(json.statistics().closed, 2);
  await assert.rejects(query.project(() => { throw new Error('consumer failed'); }).toArray(), /consumer failed/);
  assert.equal(json.statistics().opened, json.statistics().closed);
  const controller = new AbortController();
  await assert.rejects(query.project(() => { controller.abort(new Error('cancelled')); return 1; }).toArray({ signal: controller.signal }), /cancelled/);
  assert.equal(json.statistics().opened, json.statistics().closed);
}));

for (const format of formats) {
  test(`${format.root} exposes reverse mount containment to library and selector navigation`, () => fixture(async root => {
    await writeFile(join(root, 'pkg', format.name), format.text);
    const fs = createFilesystemAdapter();
    const adapter = format.create();
    const mounted = format.mount(fromFilesystem(fs, { uri: root, kinds: ['fs::file'] }), adapter);
    const schemas = [fs.schema, adapter.schema];
    const syntax = selectFrom(mounted, schemas, `fs::file > ${format.root}`);
    const parents = await syntax.traverse({ direction: 'reverse', roles: ['child'], maxDepth: 1 }).toArray();
    assert.equal(parents.length, 1);
    assert.equal(parents[0].snapshot.kind, 'fs::file');
    const owners = await selectFrom(mounted, schemas, `fs::file > ${format.root} ${format.leaf} << fs::directory[name = "pkg"]`).toArray();
    assert.equal(owners.length, 1);
    assert.equal(adapter.statistics().opened, adapter.statistics().closed);
  }));
}

test('ancestors cross embedded JSON and retain the Markdown section view and resource lifetimes', () => fixture(async root => {
  await writeFile(join(root, 'pkg', 'README.md'), '# Demo\n\n```json\n{"ok":true}\n```\n');
  const fs = createFilesystemAdapter();
  const json = createJsonAdapter();
  const markdown = createMarkdownAdapter({ json });
  const view = 'markdown::section-tree';
  const mounted = mountMarkdown(fromFilesystem(fs, { uri: root, kinds: ['fs::file'] }), markdown, { treeView: view });
  const schema = [fs.schema, markdown.schema, json.schema];
  const nodes = await selectFrom(mounted, schema, 'fs::file > markdown::document markdown::code-block > json::root json::scalar << markdown::section', { treeView: view }).toArray();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].snapshot.attributes.level, 1);
  const query = selectFrom(mounted, schema, 'fs::file > markdown::document markdown::code-block > json::root json::scalar << fs::directory', { treeView: view });
  assert.equal((await query.take(1).toArray())[0].snapshot.attributes.name, 'pkg');
  assert.equal(json.statistics().opened, json.statistics().closed);
  assert.equal(markdown.statistics().opened, markdown.statistics().closed);
  const controller = new AbortController();
  await assert.rejects(query.project(() => { controller.abort(new Error('stop')); return 1; }).toArray({ signal: controller.signal }), /stop/);
  assert.equal(json.statistics().opened, json.statistics().closed);
  assert.equal(markdown.statistics().opened, markdown.statistics().closed);
}));

test('reverse filesystem siblings retain mounts and respect the resource exclusions', () => fixture(async root => {
  await writeFile(join(root, 'pkg', 'a.json'), '{"name":"first"}');
  await writeFile(join(root, 'pkg', 'b.json'), '{"name":"ignored"}');
  await writeFile(join(root, 'pkg', 'c.json'), '{"name":"last"}');
  const fs = createFilesystemAdapter();
  const json = createJsonAdapter();
  const mounted = mountJson(fromFilesystem(fs, { uri: root, include: ['**/c.json'], exclude: ['**/b.json'], kinds: ['fs::file'] }), json);
  const query = selectFrom(mounted, [fs.schema, json.schema], 'fs::file <+ fs::file > json::root json::scalar');
  assert.deepEqual((await query.toArray()).map(node => node.snapshot.attributes.value), ['first']);
  assert.equal(json.statistics().filesRead, 1);
  assert.equal(json.statistics().opened, json.statistics().closed);
}));

test('positional predicates preserve mounted views and per-document counts', () => fixture(async root => {
  await writeFile(join(root, 'pkg', 'a.md'), '# One\n\nParagraph.\n\n# Two\n');
  await writeFile(join(root, 'pkg', 'b.md'), '# Three\n\nParagraph.\n\n# Four\n');
  const fs = createFilesystemAdapter();
  const markdown = createMarkdownAdapter();
  const mounted = mountMarkdown(fromFilesystem(fs, { uri: root, kinds: ['fs::file'] }), markdown);
  const schema = [fs.schema, markdown.schema];
  const query = selectFrom(mounted, schema, 'fs::file > markdown::document > markdown::heading:nth-child(3)');
  assert.deepEqual((await query.toArray()).map(node => node.snapshot.attributes.title), ['Two', 'Four']);
  assert.equal((await query.take(1).toArray()).length, 1);
  assert.equal(markdown.statistics().opened, markdown.statistics().closed);
  const controller = new AbortController();
  await assert.rejects(query.project(() => { controller.abort(new Error('stop')); return 1; }).toArray({ signal: controller.signal }), /stop/);
  assert.equal(markdown.statistics().opened, markdown.statistics().closed);
}));

test('scope anchors mounted file streams without reading their contents and resets for later selections', () => fixture(async root => {
  await writeFile(join(root, 'pkg', 'README.md'), '# Demo\n');
  const fs = createFilesystemAdapter();
  const syntax = createTreeSitterAdapter();
  const mounted = mountTreeSitter(fromFilesystem(fs, { uri: root, kinds: ['fs::file'] }), syntax);
  const schemas = [fs.schema, syntax.schema];
  assert.equal((await selectFrom(mounted, schemas, ':scope').toArray()).length, 1);
  assert.equal(syntax.statistics().filesRead, 0);
  const nodes = selectFrom(mounted, schemas, ':scope > treesitter::node treesitter::node[type = "atx_heading"]');
  const scoped = selectFrom(nodes, schemas, ':scope');
  assert.equal((await scoped.take(1).toArray())[0].snapshot.attributes.type, 'atx_heading');
  assert.equal(syntax.statistics().opened, syntax.statistics().closed);
  const controller = new AbortController();
  await assert.rejects(scoped.project(() => { controller.abort(new Error('stop')); return 1; }).toArray({ signal: controller.signal }), /stop/);
  assert.equal(syntax.statistics().opened, syntax.statistics().closed);
}));
