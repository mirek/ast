import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyChangePlan,
  createFilesystemAdapter,
  createJsonAdapter,
  createMarkdownAdapter,
  fromMarkdown,
  fromFilesystem,
  markdownReplaceSection,
  markdownSetHeading,
  mountMarkdown,
  planOperations,
  select,
} from "@mirek/ast";

const fixture = async (run) => {
  const root = await mkdtemp(join(tmpdir(), "ast-markdown-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const markdownFiles = (filesystem, root) =>
  fromFilesystem(filesystem, {
    uri: root,
    include: ["*.md"],
    kinds: ["fs::file"],
  });

test("Markdown syntax and semantic section trees share source provenance", async () =>
  fixture(async (root) => {
    const path = join(root, "guide.md");
    await writeFile(
      path,
      [
        "---",
        "title: Demo",
        "---",
        "# Intro",
        "Read [the docs](https://example.test).",
        "### Deep",
        "- one",
        "- [two][ref]",
        "",
        "```json",
        '{"enabled":true}',
        "```",
        "# Intro",
        "<div>opaque html</div>",
        "",
        "[ref]: https://example.test/ref",
        "",
      ].join("\n"),
    );
    const markdown = createMarkdownAdapter();

    const syntax = await select(
      markdown,
      { uri: path, treeView: "markdown::syntax-tree" },
      "markdown::document markdown::link",
      { treeView: "markdown::syntax-tree" },
    ).toArray();
    assert.deepEqual(syntax.map(({ snapshot }) => snapshot.attributes.destination), [
      "https://example.test",
      "https://example.test/ref",
    ]);

    const semantic = await select(
      markdown,
      { uri: path, treeView: "markdown::section-tree" },
      "markdown::document > markdown::section[level = 1] > markdown::section[level = 3]",
      { treeView: "markdown::section-tree" },
    ).toArray();
    assert.equal(semantic.length, 1);
    assert.equal(semantic[0]?.snapshot.attributes.title, "Deep");
    assert.equal(semantic[0]?.snapshot.origin?.uri.startsWith("file:"), true);

    const all = await select(
      markdown,
      { uri: path },
      ":is(markdown::frontmatter, markdown::heading, markdown::paragraph, markdown::list, markdown::list-item, markdown::code-block)",
    ).toArray();
    const kinds = new Set(all.map(({ snapshot }) => snapshot.kind));
    assert.deepEqual(kinds, new Set([
      "markdown::frontmatter",
      "markdown::heading",
      "markdown::paragraph",
      "markdown::list",
      "markdown::list-item",
      "markdown::code-block",
    ]));
    assert.equal(markdown.diagnostics().some(({ code }) => code === "markdown.skipped-heading-level"), true);
    const duplicateHeadings = all.filter(
      ({ snapshot }) =>
        snapshot.kind === "markdown::heading" && snapshot.attributes.title === "Intro",
    );
    assert.equal(duplicateHeadings.length, 2);
    assert.notEqual(duplicateHeadings[0]?.snapshot.id.local, duplicateHeadings[1]?.snapshot.id.local);
    await assert.rejects(
      fromMarkdown(markdown, { uri: path, treeView: "markdown::missing" }).toArray(),
      /Unknown Markdown tree view/,
    );
    assert.equal(
      all.some(
        ({ snapshot }) =>
          snapshot.kind === "markdown::paragraph" && snapshot.attributes.html === true,
      ),
      true,
    );
    await writeFile(join(root, "unclosed.md"), "---\ntitle: unfinished\n");
    await select(markdown, { uri: join(root, "unclosed.md") }, "markdown::document").toArray();
    assert.equal(
      markdown.diagnostics().some(({ code }) => code === "markdown.unclosed-frontmatter"),
      true,
    );
  }));

test("filesystem Markdown and fenced JSON mounts remain lazy and traceable", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "broken.md"), "```json\n{broken]\n");
    await writeFile(join(root, "valid.md"), "# Config\n```json\n{\"enabled\":true}\n```\n");
    const filesystem = createFilesystemAdapter();
    const json = createJsonAdapter();
    const markdown = createMarkdownAdapter({ json });
    const mounted = mountMarkdown(markdownFiles(filesystem, root), markdown);

    assert.equal(markdown.statistics().bytesRead, 0);
    assert.equal(json.statistics().parses, 0);
    assert.deepEqual(
      await mounted.project(({ snapshot }) => snapshot.attributes.path).toArray(),
      ["broken.md", "valid.md"],
    );
    assert.equal(markdown.statistics().bytesRead, 0);

    const graph = await mounted
      .traverse({ roles: ["child"], maxDepth: 10, includeSelf: true })
      .toArray();
    assert.equal(graph.some(({ snapshot }) => snapshot.kind === "markdown::document"), true);
    assert.equal(graph.some(({ snapshot }) => snapshot.kind === "json::root"), true);
    assert.equal(
      graph.some(
        ({ snapshot }) =>
          snapshot.kind === "json::scalar" && snapshot.attributes.value === true,
      ),
      true,
    );

    const jsonRoot = graph.find(({ snapshot }) => snapshot.kind === "json::root");
    assert(jsonRoot);
    const [blockEdge] = await Array.fromAsync(
      jsonRoot.edges({ names: ["json::container"], roles: ["reference"] }),
    );
    const block = blockEdge === undefined ? undefined : await jsonRoot.resolve(blockEdge.to);
    assert.equal(block?.snapshot.kind, "markdown::code-block");
    const [fileEdge] = await Array.fromAsync(
      block.edges({ names: ["markdown::container"], roles: ["reference"] }),
    );
    const file = fileEdge === undefined ? undefined : await block.resolve(fileEdge.to);
    assert.equal(file?.snapshot.kind, "fs::file");
    assert.equal(file?.snapshot.attributes.path, "valid.md");

    assert.equal(markdown.diagnostics().some(({ code }) => code === "markdown.unclosed-fence"), true);
    assert.equal(json.diagnostics().some(({ code }) => code === "json.invalid-syntax"), true);
    assert.equal(markdown.statistics().opened, 2);
    assert.equal(markdown.statistics().closed, 2);
    assert.equal(json.statistics().opened, 2);
    assert.equal(json.statistics().closed, 2);
  }));

test("Markdown semantic edits preserve unrelated bytes and apply atomically", async () =>
  fixture(async (root) => {
    const original = "\uFEFF# Old\r\nBody text.\r\n## Child\r\nChild body.\r\n";
    const path = join(root, "edit.md");
    await writeFile(path, original);
    const markdown = createMarkdownAdapter();
    const headings = await select(
      markdown,
      { uri: path },
      "markdown::heading",
    ).toArray();
    const [section] = await select(
      markdown,
      { uri: path, treeView: "markdown::section-tree" },
      'markdown::section[title = "Old"]',
      { treeView: "markdown::section-tree" },
    ).toArray();
    assert(headings[0] && section);

    const noOp = await markdown.planning.plan(
      markdownSetHeading(headings[0].snapshot, "Old"),
      {},
    );
    assert.equal(noOp[0]?.payload.content, original);

    const plan = await planOperations([
      {
        id: "heading",
        adapter: markdown,
        operation: markdownSetHeading(headings[0].snapshot, "New"),
      },
      {
        id: "section",
        adapter: markdown,
        operation: markdownReplaceSection(section.snapshot, "Updated body.\r\n"),
      },
    ]);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(plan.transactionGroups.length, 1);

    const result = await applyChangePlan(plan, [createMarkdownAdapter()]);
    assert.equal(result.groups[0]?.status, "applied");
    assert.equal(
      await readFile(path, "utf8"),
      "\uFEFF# New\r\nUpdated body.\r\n## Child\r\nChild body.\r\n",
    );
  }));
