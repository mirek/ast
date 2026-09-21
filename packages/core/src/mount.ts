import { defineEdge } from "./model.js";
import type { Edge, EdgeName, EdgeRequest, NodeSnapshot } from "./model.js";

/** Reverse containment belongs to the mount context, not the parser's tree. */
export function* mountParentEdges(
  root: NodeSnapshot,
  container: NodeSnapshot | undefined,
  name: EdgeName,
  request: EdgeRequest,
): Iterable<Edge> {
  request.signal?.throwIfAborted();
  if (container === undefined || request.direction !== "reverse") return;
  if (request.roles !== undefined && !request.roles.includes("child")) return;
  if (request.names !== undefined && !request.names.includes(name)) return;
  yield defineEdge({ name, role: "child", from: container.id, to: root.id, ordinal: 0 });
}
