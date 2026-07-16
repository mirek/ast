import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFilesystemAdapter,
  filesystemCreate,
  filesystemMove,
  filesystemRemove,
  filesystemWrite,
  fromAdapter,
  fromFilesystem,
  take,
} from "@mirek/ast";

const fixture = async (run) => {
  const root = await mkdtemp(join(tmpdir(), "ast-fs-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const paths = async (query) =>
  query.project((node) => node.snapshot.attributes.path).toArray();

test("filesystem traversal pushes safe predicates down and stops before walking the full tree", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "a.ts"), "a");
    await writeFile(join(root, "b.js"), "javascript");
    await mkdir(join(root, "later"));
    await writeFile(join(root, "later", "c.ts"), "ccc");
    await mkdir(join(root, "vendor"));
    await writeFile(join(root, "vendor", "ignored.ts"), "x");

    const adapter = createFilesystemAdapter();
    const query = fromFilesystem(adapter, {
      uri: root,
      include: ["**/*.ts"],
      exclude: ["vendor/**"],
      kinds: ["fs::file"],
      maxSize: 4,
    });

    assert.deepEqual(await paths(take(query, 1)), ["a.ts"]);
    const { ioDurationMs, ...statistics } = adapter.statistics();
    assert.deepEqual(statistics, {
      opened: 1,
      closed: 1,
      directoriesRead: 1,
      entriesRead: 4,
      nodesObserved: 2,
      ioOperations: 5,
    });
    assert.equal(ioDurationMs >= 0, true);
    assert.deepEqual(await paths(query), ["a.ts", "later/c.ts"]);

    const explained = query.filter(() => true, "runtime policy").explain();
    assert.equal(explained.physical.operator, "filter");
    assert.equal(explained.physical.details.label, "runtime policy");
    assert.equal(explained.physical.inputs[0].details.pushdown, "exclude, glob, kind, size");
  }));

test("filesystem graph keeps symlink targets on reference edges", async () =>
  fixture(async (root) => {
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "value.txt"), "value");
    await symlink("dir", join(root, "link"));
    await symlink("cycle", join(root, "cycle"));

    const adapter = createFilesystemAdapter();
    const descendants = await paths(
      take(
        fromAdapter(adapter, { uri: root }).traverse({
          roles: ["child"],
          maxDepth: 10,
        }),
        10,
      ),
    );
    assert.deepEqual(descendants, ["cycle", "dir", "dir/value.txt", "link"]);

    const [link] = await fromFilesystem(adapter, {
      uri: root,
      include: ["link"],
      kinds: ["fs::symlink"],
    }).toArray();
    assert(link);
    const edges = [];
    for await (const edge of link.edges()) edges.push(edge);
    assert.deepEqual(edges.map(({ name, role, to }) => ({ name, role, local: to.local })), [
      { name: "fs::target", role: "reference", local: "dir" },
    ]);

    const [cycle] = await fromFilesystem(adapter, {
      uri: root,
      include: ["cycle"],
      kinds: ["fs::symlink"],
    }).toArray();
    assert(cycle);
    assert.deepEqual(await Array.fromAsync(cycle.edges()), []);
    assert.equal(adapter.diagnostics().at(-1)?.code, "fs.symlink-loop");
  }));

test("filesystem planning records revisions and never performs effects", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "note.txt"), "before");
    const adapter = createFilesystemAdapter();
    const [file] = await fromFilesystem(adapter, {
      uri: root,
      include: ["note.txt"],
      kinds: ["fs::file"],
    }).toArray();
    const [directory] = await fromAdapter(adapter, { uri: root }).toArray();
    assert(file);
    assert(directory);

    const operations = [
      filesystemWrite(file.snapshot, { encoding: "utf8", content: "after" }),
      filesystemMove(file.snapshot, "moved.txt"),
      filesystemRemove(file.snapshot),
      filesystemCreate(directory.snapshot, "created.txt", "file", {
        encoding: "utf8",
        content: "created",
      }),
    ];
    const changes = (await Promise.all(
      operations.map((operation) => adapter.planning.plan(operation, {})),
    )).flat();

    assert.deepEqual(changes.map(({ kind, risk }) => [kind, risk]), [
      ["fs::write", "destructive"],
      ["fs::move", "safe"],
      ["fs::remove", "destructive"],
      ["fs::create", "safe"],
    ]);
    assert.equal(changes.every((change) => change.preconditions.length > 0), true);
    assert.equal(await readFile(join(root, "note.txt"), "utf8"), "before");
    await assert.rejects(readFile(join(root, "moved.txt")), /ENOENT/);
    await assert.rejects(readFile(join(root, "created.txt")), /ENOENT/);

    await writeFile(join(root, "note.txt"), "changed externally");
    assert.deepEqual(await adapter.planning.plan(operations[0], {}), []);
    assert.equal(adapter.diagnostics().at(-1)?.code, "fs.revision-conflict");
  }));

test("filesystem observations keep file contents opaque and diagnostics content-free", async () =>
  fixture(async (root) => {
    const secret = "DO-NOT-LEAK";
    await writeFile(join(root, "large.bin"), Buffer.alloc(1024, 1));
    await writeFile(join(root, "vanishing.txt"), secret);
    const adapter = createFilesystemAdapter();
    const nodes = await fromFilesystem(adapter, { uri: root }).toArray();
    const large = nodes.find((node) => node.snapshot.attributes.path === "large.bin");
    const vanishing = nodes.find(
      (node) => node.snapshot.attributes.path === "vanishing.txt",
    );
    assert(large);
    assert(vanishing);
    assert.equal(large.snapshot.attributes.size, 1024);
    assert.equal(large.snapshot.attributes.contentKind, "opaque");
    assert.equal(Object.hasOwn(large.snapshot.attributes, "content"), false);

    await rm(join(root, "vanishing.txt"));
    const planned = await adapter.planning.plan(
      filesystemWrite(vanishing.snapshot, { encoding: "utf8", content: secret }),
      {},
    );
    assert.deepEqual(planned, []);
    const diagnostics = adapter.diagnostics();
    assert.equal(diagnostics.at(-1)?.code, "fs.path-disappeared");
    assert.equal(diagnostics.at(-1)?.message.includes(secret), false);
    assert.equal(diagnostics.at(-1)?.locations[0]?.kind, "source");
  }));

test("filesystem traversal propagates cancellation and closes resources", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    const adapter = createFilesystemAdapter();
    const controller = new AbortController();
    const query = fromFilesystem(adapter, { uri: root }).filter((node) => {
      if (node.snapshot.attributes.path === "a.txt") {
        controller.abort(new Error("stop filesystem"));
      }
      return true;
    });

    await assert.rejects(query.toArray({ signal: controller.signal }), /stop filesystem/);
    assert.equal(adapter.statistics().opened, 1);
    assert.equal(adapter.statistics().closed, 1);
  }));
