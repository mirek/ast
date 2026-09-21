import { AsyncLocalStorage } from "node:async_hooks";
import type { ResourceHandle } from "./adapter.js";

interface BufferResources { readonly handles: Set<ResourceHandle>; closed: boolean; }

// Collection runs upstream iterators to completion before emitting their rows.
// Keep their resources alive until the outermost enclosing buffer is consumed.
// Async-local ownership isolates concurrent queries without changing signals or
// requiring adapters to understand query operators.
const collecting = new AsyncLocalStorage<BufferResources>();

export const closeQueryResource = async (handle: ResourceHandle): Promise<void> => {
  const scope = collecting.getStore();
  if (scope !== undefined && !scope.closed) scope.handles.add(handle);
  else await handle.close();
};

export const collectWithResources = async <Value>(
  collect: () => Promise<Value>,
): Promise<{ readonly value: Value; close(): Promise<void> }> => {
  const enclosing = collecting.getStore();
  if (enclosing !== undefined && !enclosing.closed) {
    return { value: await collect(), async close() {} };
  }
  const scope: BufferResources = { handles: new Set(), closed: false };
  const close = async (): Promise<void> => {
    if (scope.closed) return;
    scope.closed = true;
    const handles = [...scope.handles];
    scope.handles.clear();
    const errors: unknown[] = [];
    // Preserve nested-resource close order and attempt every cleanup on failure.
    await handles.reduce(async (previous, handle) => {
      await previous;
      try { await handle.close(); } catch (error) { errors.push(error); }
    }, Promise.resolve());
    if (errors.length > 0) throw new AggregateError(errors, "Buffered resource cleanup failed.");
  };
  try {
    return { value: await collecting.run(scope, collect), close };
  } catch (error) {
    try { await close(); } catch (cleanup) {
      // Both failures are retained; AggregateError takes options as its third argument.
      // oxlint-disable-next-line preserve-caught-error
      throw new AggregateError([error, cleanup], "Buffered collection and cleanup failed.", { cause: cleanup });
    }
    throw error;
  }
};
