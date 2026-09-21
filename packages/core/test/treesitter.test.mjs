import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { createTreeSitterAdapter, treeSitterGrammars, fromAdapter, fromValues, fromFilesystem, createFilesystemAdapter, mountTreeSitter, sort, select, selectFrom, validateAdapter } from '@mirek/ast';

const fixture = async (run) => {
  const root = await mkdtemp(join(tmpdir(), 'ast-treesitter-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
};

test('Tree-sitter projects grammar types, fields, Unicode ranges, and reverse syntax edges', () => fixture(async root => {
  const uri = join(root, 'example.py');
  const text = 'def café(x):\n    return "😀"\n';
  await writeFile(uri, text);
  const adapter = createTreeSitterAdapter();
  validateAdapter(adapter);
  const nodes = await select(adapter, { uri }, 'treesitter::node[type = "function_definition"] > treesitter::node[field = "name"]').toArray();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].snapshot.attributes.text, 'café');
  const { start, end } = nodes[0].snapshot.origin.range;
  assert.equal(text.slice(start, end), 'café');
  const parents = await select(adapter, { uri }, 'treesitter::node[field = "name"] <-treesitter::children treesitter::node').toArray();
  assert.equal(parents[0].snapshot.attributes.type, 'function_definition');
  const strings = await select(adapter, { uri }, 'treesitter::node[type = "string"]').toArray();
  assert.equal(text.slice(strings[0].snapshot.origin.range.start, strings[0].snapshot.origin.range.end), '"😀"');
  assert.equal(adapter.statistics().opened, adapter.statistics().closed);
}));

test('Tree-sitter mounts are lazy, preserve captures and ownership, and close on take', () => fixture(async root => {
  await writeFile(join(root, 'one.py'), 'def first(): pass\n');
  await writeFile(join(root, 'two.py'), 'def second(): pass\n');
  const fs = createFilesystemAdapter();
  const adapter = createTreeSitterAdapter();
  const mounted = mountTreeSitter(fromFilesystem(fs, { uri: root, kinds: ['fs::file'] }), adapter);
  const schema = [fs.schema, adapter.schema];
  await selectFrom(mounted, schema, 'fs::file', { sourceMode: 'selection' }).toArray();
  assert.equal(adapter.statistics().filesRead, 0);
  const rows = await selectFrom(mounted, schema, 'fs::file as $file > treesitter::node treesitter::node[type = "function_definition"]', { sourceMode: 'selection' })
    .project((node, captures) => ({ name: captures.file.snapshot.attributes.name, type: node.snapshot.attributes.type })).take(1).toArray();
  assert.deepEqual(rows, [{ name: 'one.py', type: 'function_definition' }]);
  assert.equal(adapter.statistics().filesRead, 1);
  assert.equal(adapter.statistics().opened, adapter.statistics().closed);
  const owners = await selectFrom(mounted, schema, 'fs::file > treesitter::node ->treesitter::container fs::file', { sourceMode: 'selection' }).toArray();
  assert.deepEqual(owners.map(n => n.snapshot.attributes.name), ['one.py', 'two.py']);
}));

test('Tree-sitter accepts explicit grammars for extensionless files and recovers syntax errors', () => fixture(async root => {
  const uri = join(root, 'script');
  await writeFile(uri, 'def broken(:\n');
  const adapter = createTreeSitterAdapter();
  await assert.rejects(select(adapter, { uri }, 'treesitter::node').toArray(), /grammar/i);
  const nodes = await select(adapter, { uri, options: { language: 'python' } }, 'treesitter::node[hasError = true]').toArray();
  assert.ok(nodes.length > 0);
  assert.ok(adapter.diagnostics().some(d => d.code === 'treesitter.syntax-error' && d.locations.some(l => l.origin?.range)));
  assert.equal(adapter.statistics().opened, adapter.statistics().closed);
}));

test('Tree-sitter exposes a frozen extensible grammar registry', () => fixture(async root => {
  assert.ok(Object.isFrozen(treeSitterGrammars));
  const python = treeSitterGrammars.find(g => g.name === 'python');
  const uri = join(root, 'sample.custom');
  await writeFile(uri, 'x = 1\n');
  const adapter = createTreeSitterAdapter({ grammars: [{ ...python, name: 'custom', extensions: ['.custom'], wasm: fileURLToPath(import.meta.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm')) }] });
  const nodes = await select(adapter, { uri }, 'treesitter::node[language = "custom"][type = "identifier"]').toArray();
  assert.equal(nodes[0].snapshot.attributes.text, 'x');
}));

test('custom grammar configuration accepts Windows paths while rejecting remote URI schemes', () => {
  for (const wasm of [String.raw`C:\grammars\custom.wasm`, 'C:/grammars/custom.wasm', String.raw`\\server\share\custom.wasm`, '/grammars/custom.wasm', './grammars/custom.wasm', 'file:///C:/grammars/custom.wasm']) {
    const adapter = createTreeSitterAdapter({ grammars: [{ name: 'custom', wasm, extensions: ['.custom'] }] });
    assert.equal(adapter.grammars[0].wasm, wasm);
  }
  for (const wasm of ['https://example.com/custom.wasm', 'git+https://example.com/custom.wasm', 'data:application/wasm;base64,AA==']) {
    assert.throws(() => createTreeSitterAdapter({ grammars: [{ name: 'custom', wasm, extensions: ['.custom'] }] }), /local path or file URL/u);
  }
});

test('every bundled grammar loads and parses with the pinned runtime', () => fixture(async root => {
  const uri = join(root, 'empty');
  await writeFile(uri, '');
  const adapter = createTreeSitterAdapter();
  await Promise.all(treeSitterGrammars.map(async grammar => {
    const roots = await select(adapter, { uri, options: { language: grammar.name } }, 'treesitter::node').take(1).toArray();
    assert.equal(roots[0].snapshot.attributes.language, grammar.name);
  }));
  assert.equal(adapter.statistics().opened, treeSitterGrammars.length);
  assert.equal(adapter.statistics().closed, adapter.statistics().opened);
}));

test('concurrent opens retain independent lifetimes and content revisions', () => fixture(async root => {
  const uri = join(root, 'data.json');
  await writeFile(uri, '{"ok":true}');
  const adapter = createTreeSitterAdapter();
  const [first, second] = await Promise.all([adapter.read.open({ uri }, {}), adapter.read.open({ uri }, {})]);
  assert.equal(first.resource.id, second.resource.id);
  await first.close();
  const roots = [];
  for await (const node of adapter.read.roots(second.resource, {})) roots.push(node);
  assert.equal(roots[0].attributes.type, 'document');
  await writeFile(uri, '{"ok":false}');
  const changed = await adapter.read.open({ uri }, {});
  assert.notEqual(changed.resource.revision, second.resource.revision);
  assert.notEqual(changed.resource.id, second.resource.id);
  await second.close();
  await second.close();
  await changed.close();
  assert.equal(adapter.statistics().opened, adapter.statistics().closed);
}));

test('cancellation and consumer failures close mounted Tree-sitter resources', () => fixture(async root => {
  await writeFile(join(root, 'data.py'), 'x = 1\n');
  const fs = createFilesystemAdapter();
  const adapter = createTreeSitterAdapter();
  const query = selectFrom(mountTreeSitter(fromFilesystem(fs, { uri: root, kinds: ['fs::file'] }), adapter), [fs.schema, adapter.schema], 'fs::file > treesitter::node treesitter::node');
  const controller = new AbortController();
  await assert.rejects(query.project(() => { controller.abort(new Error('stop')); return 1; }).toArray({ signal: controller.signal }), /stop/);
  assert.equal(adapter.statistics().opened, adapter.statistics().closed);
  await assert.rejects(query.project(() => { throw new Error('consumer'); }).toArray(), /consumer/);
  assert.equal(adapter.statistics().opened, adapter.statistics().closed);
  const before = adapter.statistics();
  await assert.rejects(query.toArray({ signal: controller.signal }), /stop/);
  assert.deepEqual(adapter.statistics(), before);
}));

test('Tree-sitter parses representative data, document, and code formats without recovery', () => fixture(async root => {
  const samples = [
    ['config.yaml', 'name: demo\nenabled: true\n', 'block_mapping_pair'],
    ['config.toml', '[package]\nname = "demo"\n', 'pair'],
    ['main.rs', 'fn main() {}\n', 'function_item'],
    ['Dockerfile', 'FROM alpine\nRUN echo hello\n', 'from_instruction'],
    ['index.html', '<h1>Hello</h1>\n', 'element'],
    ['main.ts', 'export function hello() { return 1; }\n', 'function_declaration'],
    ['README.md', '# Hello\n\nText.\n', 'atx_heading'],
  ];
  const adapter = createTreeSitterAdapter();
  await Promise.all(samples.map(async ([name, text, type]) => {
    const uri = join(root, name);
    await writeFile(uri, text);
    const rows = await select(adapter, { uri }, `treesitter::node[type = "${type}"]`).toArray();
    assert.equal(rows.length > 0, true, name);
    for (const { snapshot } of rows) {
      assert.equal(snapshot.attributes.hasError, false, name);
      assert.equal(text.slice(snapshot.origin.range.start, snapshot.origin.range.end), snapshot.attributes.text, name);
    }
  }));
  assert.deepEqual(adapter.diagnostics(), []);
}));

test('Tree-sitter Unicode coordinates retain BOM and CRLF in the original text', () => fixture(async root => {
  const uri = join(root, 'unicode.json');
  const text = '\uFEFF{\r\n  "é😀": "雪😀"\r\n}\r\n';
  await writeFile(uri, text);
  const adapter = createTreeSitterAdapter();
  const nodes = await select(adapter, { uri }, 'treesitter::node[type = "string"]').toArray();
  assert.equal(nodes.length, 2);
  for (const { snapshot } of nodes) {
    const range = snapshot.origin.range;
    assert.equal(text.slice(range.start, range.end), snapshot.attributes.text);
    assert.equal(range.startLine, 1);
    assert.equal(range.startColumn, range.start - text.indexOf('\n') - 1);
    assert.equal(range.endColumn - range.startColumn, snapshot.attributes.text.length);
  }
}));

test('Tree-sitter mount error policies skip discovery misses and reject unreadable text explicitly', () => fixture(async root => {
  await writeFile(join(root, 'binary.py'), Uint8Array.of(0xff, 0xfe));
  await writeFile(join(root, 'opaque.unknown'), 'opaque');
  const fs = createFilesystemAdapter();
  const files = fromFilesystem(fs, { uri: root, kinds: ['fs::file'] });
  const adapter = createTreeSitterAdapter();
  const query = options => selectFrom(mountTreeSitter(files, adapter, options), [fs.schema, adapter.schema], 'fs::file > treesitter::node');
  assert.deepEqual(await query({}).toArray(), []);
  assert.equal(adapter.statistics().filesRead, 1);
  assert.equal(adapter.diagnostics()[0].code, 'treesitter.open-failed');
  await assert.rejects(query({ onError: 'throw' }).toArray(), /encoded data|encoding/i);
  assert.equal(adapter.statistics().opened, 0);
  assert.throws(() => mountTreeSitter(files, adapter, { language: 'missing' }), /Unknown/);
}));

test('mounted grammar navigation survives directory steps and return through the container', () => fixture(async root => {
  await writeFile(join(root, 'README.md'), '# Hello\n');
  const fs = createFilesystemAdapter();
  const adapter = createTreeSitterAdapter();
  const files = fromFilesystem(fs, { uri: root });
  const mounted = mountTreeSitter(files, adapter);
  const schema = [fs.schema, adapter.schema];
  const nodes = await selectFrom(mounted, schema, 'fs::directory > fs::file > treesitter::node treesitter::node[type = "atx_heading"]').toArray();
  assert.equal(nodes.length, 1);
  const reentered = await selectFrom(mounted, schema, 'fs::file > treesitter::node ->treesitter::container fs::file > treesitter::node').toArray();
  assert.equal(reentered.length, 1);
  assert.equal(adapter.statistics().opened, adapter.statistics().closed);
}));

test('Tree-sitter parses the repository README and long Markdown documents', () => fixture(async root => {
  const adapter = createTreeSitterAdapter();
  const readme = fileURLToPath(new URL('../../../README.md', import.meta.url));
  const headings = await select(adapter, { uri: readme }, 'treesitter::node[type = "atx_heading"]').take(3).toArray();
  assert.equal(headings.length, 3);
  assert.equal(headings[0].snapshot.attributes.text, '# ast\n');
  const uri = join(root, 'large.md');
  await writeFile(uri, '# Large\n\n' + 'hello '.repeat(6000));
  const rows = await select(adapter, { uri }, 'treesitter::node[type = "atx_heading"]').toArray();
  assert.equal(rows.length, 1);
  assert.deepEqual(adapter.diagnostics(), []);
  assert.equal(adapter.statistics().opened, adapter.statistics().closed);
}));

test('buffered Tree-sitter nodes remain navigable through sorting, grouping, and joins', () => fixture(async root => {
  const uri = join(root, 'file.py');
  await writeFile(uri, 'def first(): pass\ndef second(): pass\n');
  const adapter = createTreeSitterAdapter();
  const source = fromAdapter(adapter, { uri });
  const sorted = sort(source, () => 0);
  const grouped = source.groupBy(() => 0).flatMap(group => group.values);
  const joined = fromValues([1]).join(source, { leftKey: () => 1, rightKey: () => 1 }).project(pair => pair[1]);
  await Promise.all([sorted, grouped, joined, sort(sorted, () => 0)].map(async query => {
    const names = await selectFrom(query, adapter.schema, 'treesitter::node[type = "function_definition"] > treesitter::node[field = "name"]').project(node => node.snapshot.attributes.text).toArray();
    assert.deepEqual(names, ['first', 'second']);
  }));
  assert.equal(adapter.statistics().opened, adapter.statistics().closed);
}));

test('buffered mounts preserve navigation and close resources on take, failure, and cancellation', () => fixture(async root => {
  await writeFile(join(root, 'file.py'), 'def first(): pass\ndef second(): pass\n');
  const fs = createFilesystemAdapter();
  const adapter = createTreeSitterAdapter();
  const nodes = selectFrom(mountTreeSitter(fromFilesystem(fs, { uri: root, kinds: ['fs::file'] }), adapter), [fs.schema, adapter.schema], 'fs::file > treesitter::node treesitter::node[type = "function_definition"]');
  const buffered = sort(nodes, (a, b) => b.snapshot.attributes.text.localeCompare(a.snapshot.attributes.text));
  const names = selectFrom(buffered, adapter.schema, ':scope > treesitter::node[field = "name"]').project(node => node.snapshot.attributes.text);
  assert.deepEqual(await names.take(1).toArray(), ['second']);
  await assert.rejects(names.project(() => { throw new Error('downstream'); }).toArray(), /downstream/u);
  const controller = new AbortController();
  await assert.rejects(names.project(() => { controller.abort(new Error('cancel buffered')); return 1; }).toArray({ signal: controller.signal }), /cancel buffered/u);
  await assert.rejects(sort(nodes, () => { throw new Error('comparison'); }).toArray(), /comparison/u);
  assert.equal(adapter.statistics().opened, adapter.statistics().closed);
}));

test('Tree-sitter mount policies reject drift from the observed filesystem container', () => fixture(async root => {
  const uri = join(root, 'file.py');
  await writeFile(uri, 'before = 1\n');
  const fs = createFilesystemAdapter();
  const [file] = await fromFilesystem(fs, { uri }).toArray();
  await writeFile(uri, 'after = 2\n');
  const adapter = createTreeSitterAdapter();
  const query = onError => selectFrom(mountTreeSitter(fromValues([file]), adapter, { onError }), [fs.schema, adapter.schema], 'fs::file > treesitter::node');
  assert.deepEqual(await query('skip').toArray(), []);
  assert.equal(adapter.diagnostics()[0].code, 'treesitter.open-failed');
  await assert.rejects(query('throw').toArray(), /changed/u);
  assert.equal(adapter.statistics().opened, adapter.statistics().closed);
  assert.equal(adapter.statistics().parses, 0);
  assert.equal((await select(adapter, { uri }, 'treesitter::node[type = "identifier"]').toArray())[0].snapshot.attributes.text, 'after');
}));
