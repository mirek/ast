import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createJsonAdapter, createMarkdownAdapter, fromMarkdown, jsonReplaceValue, markdownSetHeading, select, selectFrom } from "@mirek/ast";

const formats = [
  { name: "JSON", create: createJsonAdapter, before: '{"name":"before"}', after: '{"name":"after"}', selector: "json::scalar", edit: (node) => jsonReplaceValue(node, "edited") },
  { name: "Markdown", create: createMarkdownAdapter, before: "# Before\n", after: "# After\n", selector: "markdown::heading", edit: (node) => markdownSetHeading(node, "Edited") },
];

for (const format of formats) {
  test(`${format.name} reopens preserve earlier identities, hydration, and stale planning guards`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ast-observation-"));
    try {
      const uri = join(root, "file");
      const adapter = format.create();
      await writeFile(uri, format.before);
      const firstResource = await adapter.read.open({ uri }, {});
      try {
        const [firstRoot] = await Array.fromAsync(adapter.read.roots(firstResource.resource, {}));
        const [before] = await select(adapter, { uri }, format.selector).toArray();
        const firstEdges = await Array.fromAsync(before.edges());
        await writeFile(uri, format.after);
        const [after] = await select(adapter, { uri }, format.selector).toArray();
        assert.notDeepEqual(after.snapshot.id, before.snapshot.id);
        assert.deepEqual(await adapter.read.hydrate([before.snapshot.id], { attributes: [] }), [before.snapshot]);
        assert.deepEqual(await Array.fromAsync(before.edges()), firstEdges);
        assert.deepEqual(await Array.fromAsync(adapter.read.roots(firstResource.resource, {})), [firstRoot]);
        // Even operations without an optional expectedRevision retain the old observation.
        const { expectedRevision: _revision, ...operation } = format.edit(before.snapshot);
        assert.deepEqual(await adapter.planning.plan(operation, {}), []);
        assert(adapter.diagnostics().some(({ code }) => code.endsWith("revision-conflict")));
      } finally { await firstResource.close(); }
      assert.equal(adapter.statistics().opened, adapter.statistics().closed);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test(`${format.name} simultaneous mounts retain their own container`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ast-mount-observation-"));
    try {
      const uri = join(root, "file");
      await writeFile(uri, format.before);
      const adapter = format.create();
      const containers = ["first", "second"].map((local) => ({ id: { adapter: "fs", resource: "fixture", local }, kind: "fs::file", attributes: {} }));
      const handles = await Promise.all(containers.map((node) => adapter.mount.open(node, { uri }, {})));
      try {
        await handles[0].close();
        await Promise.all(handles.map(async (handle, index) => {
          const [node] = await Array.fromAsync(adapter.read.roots(handle.resource, {}));
          const [edge] = await Array.fromAsync(adapter.read.edges(node.id, { names: [`${adapter.namespace}::container`] }));
          assert.deepEqual(edge.to, containers[index].id);
        }));
      } finally { await Promise.all(handles.map((handle) => handle.close())); }
      assert.equal(adapter.statistics().opened, adapter.statistics().closed);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("embedded JSON revisions retain their earlier Markdown container and remain read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "ast-embedded-observation-"));
  try {
    const uri = join(root, "file.md");
    const json = createJsonAdapter();
    const markdown = createMarkdownAdapter({ json });
    await writeFile(uri, '```json\n{"name":"before"}\n```\n');
    const [before] = await selectFrom(fromMarkdown(markdown, { uri }), markdown.schema, "markdown::code-block").toArray();
    const [mount] = await Array.fromAsync(before.edges({ names: ["json::mount"] }));
    const earlier = await before.resolve(mount.to);
    const earlierEdges = await Array.fromAsync(earlier.edges());
    await writeFile(uri, '```json\n{"name":"after"}\n```\n');
    const [after] = await selectFrom(fromMarkdown(markdown, { uri }), markdown.schema, "markdown::code-block").toArray();
    const [newMount] = await Array.fromAsync(after.edges({ names: ["json::mount"] }));
    assert.notDeepEqual(newMount.to, mount.to);
    assert.deepEqual(await Array.fromAsync(earlier.edges()), earlierEdges);
    const [owner] = await Array.fromAsync(earlier.edges({ names: ["json::container"] }));
    assert.deepEqual(owner.to, before.snapshot.id);
    await assert.rejects(json.planning.plan(jsonReplaceValue(earlier.snapshot, {}), {}), /read-only/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
