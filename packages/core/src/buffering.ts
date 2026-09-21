import { AsyncLocalStorage } from "node:async_hooks";
import type { ResourceHandle } from "./adapter.js";

interface BufferResources { readonly handles: Set<ResourceHandle>; closed: boolean; }
interface PrimaryFailure { readonly error: unknown; }

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
): Promise<{ readonly value: Value; close(failure?: PrimaryFailure): Promise<void> }> => {
  const enclosing = collecting.getStore();
  if (enclosing !== undefined && !enclosing.closed) {
    return { value: await collect(), async close() {} };
  }
  const scope: BufferResources = { handles: new Set(), closed: false };
  const close = async (failure?: PrimaryFailure): Promise<void> => {
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
    if (errors.length > 0) throw failure === undefined
      ? new AggregateError(errors, "Buffered resource cleanup failed.")
      : new AggregateError([failure.error, ...errors], "Buffered execution and cleanup failed.", { cause: failure.error });
  };
  try {
    return { value: await collecting.run(scope, collect), close };
  } catch (error) {
    await close({ error });
    throw error;
  }
};
