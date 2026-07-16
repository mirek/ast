import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyChangePlan,
  createFilesystemAdapter,
  createJsonAdapter,
  deserializeChangePlan,
  filesystemCreate,
  filesystemMove,
  filesystemRemove,
  filesystemWrite,
  fromAdapter,
  fromFilesystem,
  jsonInsertProperty,
  jsonReplaceValue,
  mountJson,
  planOperations,
  renderChangePlan,
  serializeChangePlan,
} from "@mirek/ast";

const fixture = async (run) => {
  const root = await mkdtemp(join(tmpdir(), "ast-change-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const fileNode = async (filesystem, root, path) => {
  const [node] = await fromFilesystem(filesystem, {
    uri: root,
    include: [path],
    kinds: ["fs::file"],
  }).toArray();
  assert(node);
  return node;
};

const jsonNodes = async (filesystem, json, root, path) =>
  mountJson(
    fromFilesystem(filesystem, {
      uri: root,
      include: [path],
      kinds: ["fs::file"],
    }),
    json,
  )
    .traverse({ roles: ["child"], maxDepth: 8 })
    .toArray();

test("change plans compose adapters, remain pure, render safely, and persist identity", async () =>
  fixture(async (root) => {
    const notePath = join(root, "note.txt");
    const jsonPath = join(root, "config.json");
    await writeFile(notePath, "before secret\n");
    await writeFile(jsonPath, '{\n  "name": "before secret"\n}\n');

    const filesystem = createFilesystemAdapter();
    const json = createJsonAdapter();
    const note = await fileNode(filesystem, root, "note.txt");
    const graph = await jsonNodes(filesystem, json, root, "config.json");
    const name = graph.find(
      ({ snapshot }) =>
        snapshot.kind === "json::scalar" && snapshot.attributes.value === "before secret",
    );
    assert(name);

    const plan = await planOperations([
      {
        id: "write-note",
        adapter: filesystem,
        operation: filesystemWrite(note.snapshot, {
          encoding: "utf8",
          content: "after secret\n",
        }),
      },
      {
        id: "edit-config",
        adapter: json,
        operation: jsonReplaceValue(name.snapshot, "after secret"),
        dependsOn: ["write-note"],
      },
    ]);

    assert.equal(await readFile(notePath, "utf8"), "before secret\n");
    assert.equal(await readFile(jsonPath, "utf8"), '{\n  "name": "before secret"\n}\n');
    assert.equal(plan.diagnostics.length, 0);
    assert.deepEqual(plan.changes.map(({ id, risk }) => [id, risk]), [
      ["write-note:0", "destructive"],
      ["edit-config:0", "destructive"],
    ]);
    assert.deepEqual(plan.transactionGroups.map(({ changeIds, dependsOn }) => [changeIds, dependsOn]), [
      [["write-note:0"], []],
      [["edit-config:0"], ["group:write-note:0"]],
    ]);

    const safeRendering = renderChangePlan(plan);
    assert.equal(safeRendering.includes("before secret"), false);
    assert.match(safeRendering, /content redacted/);
    const detailedRendering = renderChangePlan(plan, { includeSensitive: true });
    assert.match(detailedRendering, /-before secret/);
    assert.match(detailedRendering, /\+after secret/);

    const saved = serializeChangePlan(plan);
    const loaded = deserializeChangePlan(saved, {
      adapters: [filesystem, json],
      resources: plan.resources,
    });
    assert.deepEqual(loaded, plan);
    assert.throws(
      () =>
        deserializeChangePlan(saved, {
          adapters: [
            { ...filesystem, schema: { ...filesystem.schema, version: "2.0.0" } },
            json,
          ],
          resources: plan.resources,
        }),
      /schema version/,
    );
    assert.throws(
      () =>
        deserializeChangePlan(saved, {
          adapters: [filesystem, json],
          resources: plan.resources.map((resource, index) =>
            index === 0
              ? Object.assign({}, resource, { uri: `${resource.uri}-other` })
              : resource,
          ),
        }),
      /resource identity/,
    );
  }));

test("overlapping changes are diagnosed while non-overlapping JSON edits apply atomically", async () =>
  fixture(async (root) => {
    const textPath = join(root, "same.txt");
    const jsonPath = join(root, "data.json");
    await writeFile(textPath, "before");
    await writeFile(jsonPath, '{"name":"before","enabled":false}\n');
    const filesystem = createFilesystemAdapter();
    const text = await fileNode(filesystem, root, "same.txt");

    const conflict = await planOperations([
      {
        id: "first",
        adapter: filesystem,
        operation: filesystemWrite(text.snapshot, { encoding: "utf8", content: "first" }),
      },
      {
        id: "second",
        adapter: filesystem,
        operation: filesystemWrite(text.snapshot, { encoding: "utf8", content: "second" }),
      },
    ]);
    assert.equal(conflict.diagnostics.at(-1)?.code, "plan.overlapping-changes");
    await assert.rejects(
      applyChangePlan(conflict, [filesystem]),
      /contains error diagnostics/,
    );
    assert.equal(await readFile(textPath, "utf8"), "before");

    const json = createJsonAdapter();
    const graph = await jsonNodes(filesystem, json, root, "data.json");
    const object = graph.find(({ snapshot }) => snapshot.kind === "json::object");
    const name = graph.find(
      ({ snapshot }) =>
        snapshot.kind === "json::scalar" && snapshot.attributes.value === "before",
    );
    assert(object && name);
    const plan = await planOperations([
      {
        id: "rename",
        adapter: json,
        operation: jsonReplaceValue(name.snapshot, "after"),
      },
      {
        id: "insert",
        adapter: json,
        operation: jsonInsertProperty(object.snapshot, "count", 2),
      },
    ]);
    assert.equal(plan.diagnostics.length, 0);
    assert.equal(plan.transactionGroups.length, 1);
    assert.equal(plan.transactionGroups[0]?.atomic, true);
    assert.equal(await readFile(jsonPath, "utf8"), '{"name":"before","enabled":false}\n');

    const result = await applyChangePlan(plan, [createJsonAdapter()]);
    assert.deepEqual(result.groups.map(({ status }) => status), ["applied"]);
    assert.equal(
      await readFile(jsonPath, "utf8"),
      '{"name":"after","enabled":false,"count":2}\n',
    );
  }));

test("apply revalidates revisions and skips dependents while continuing independent groups", async () =>
  fixture(async (root) => {
    await Promise.all([
      writeFile(join(root, "a.txt"), "a0"),
      writeFile(join(root, "b.txt"), "b0"),
      writeFile(join(root, "c.txt"), "c0"),
    ]);
    const filesystem = createFilesystemAdapter();
    const [a, b, c] = await Promise.all(
      ["a.txt", "b.txt", "c.txt"].map((path) => fileNode(filesystem, root, path)),
    );
    const plan = await planOperations([
      {
        id: "a",
        adapter: filesystem,
        operation: filesystemWrite(a.snapshot, { encoding: "utf8", content: "a1" }),
      },
      {
        id: "b",
        adapter: filesystem,
        operation: filesystemWrite(b.snapshot, { encoding: "utf8", content: "b1" }),
        dependsOn: ["a"],
      },
      {
        id: "c",
        adapter: filesystem,
        operation: filesystemWrite(c.snapshot, { encoding: "utf8", content: "c1" }),
      },
    ]);

    await writeFile(join(root, "a.txt"), "externally changed");
    const stopped = await applyChangePlan(plan, [createFilesystemAdapter()]);
    assert.deepEqual(stopped.groups.map(({ id, status }) => [id, status]), [
      ["group:a:0", "failed"],
      ["group:b:0", "skipped-dependency"],
      ["group:c:0", "skipped-policy"],
    ]);
    assert.equal(stopped.partialApplication, false);

    const result = await applyChangePlan(plan, [createFilesystemAdapter()], {
      failurePolicy: "continue-independent",
    });
    assert.deepEqual(result.groups.map(({ id, status }) => [id, status]), [
      ["group:a:0", "failed"],
      ["group:b:0", "skipped-dependency"],
      ["group:c:0", "applied"],
    ]);
    assert.equal(result.partialApplication, true);
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "externally changed");
    assert.equal(await readFile(join(root, "b.txt"), "utf8"), "b0");
    assert.equal(await readFile(join(root, "c.txt"), "utf8"), "c1");

    const stale = await planOperations([
      {
        id: "stale",
        adapter: filesystem,
        operation: filesystemWrite(a.snapshot, { encoding: "utf8", content: "late" }),
      },
    ]);
    assert.equal(stale.changes.length, 0);
    assert.equal(stale.diagnostics.at(-1)?.code, "fs.revision-conflict");
  }));

test("filesystem apply executes create, move, and remove changes explicitly", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "move.txt"), "move");
    await writeFile(join(root, "remove.txt"), "remove");
    const filesystem = createFilesystemAdapter();
    const [directory] = await fromAdapter(filesystem, { uri: root }).toArray();
    const move = await fileNode(filesystem, root, "move.txt");
    const remove = await fileNode(filesystem, root, "remove.txt");
    assert(directory);

    const plan = await planOperations([
      {
        id: "create",
        adapter: filesystem,
        operation: filesystemCreate(directory.snapshot, "created.txt", "file", {
          encoding: "utf8",
          content: "created",
        }),
      },
      {
        id: "move",
        adapter: filesystem,
        operation: filesystemMove(move.snapshot, "moved.txt"),
      },
      {
        id: "remove",
        adapter: filesystem,
        operation: filesystemRemove(remove.snapshot),
      },
    ]);
    assert.equal(plan.diagnostics.length, 0);
    assert.equal(await readFile(join(root, "move.txt"), "utf8"), "move");

    const result = await applyChangePlan(plan, [createFilesystemAdapter()]);
    assert.deepEqual(result.groups.map(({ status }) => status), [
      "applied",
      "applied",
      "applied",
    ]);
    assert.equal(await readFile(join(root, "created.txt"), "utf8"), "created");
    assert.equal(await readFile(join(root, "moved.txt"), "utf8"), "move");
    await assert.rejects(readFile(join(root, "move.txt")), /ENOENT/);
    await assert.rejects(readFile(join(root, "remove.txt")), /ENOENT/);
  }));
