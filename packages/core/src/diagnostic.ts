import { immutableCopy } from "./immutable.js";
import { assertNamespace, assertNamespacedName } from "./model.js";
import type {
  NamespacedName,
  NodeId,
  OperationKind,
  Origin,
  SourceRange,
} from "./model.js";

export type DiagnosticSeverity = "info" | "warning" | "error";

export type DiagnosticLocation =
  | {
      readonly kind: "program";
      readonly uri: string;
      readonly range?: SourceRange;
    }
  | {
      readonly kind: "source";
      readonly origin: Origin;
    }
  | {
      readonly kind: "node";
      readonly node: NodeId;
      readonly origin?: Origin;
    }
  | {
      readonly kind: "adapter";
      readonly adapter: string;
    }
  | {
      readonly kind: "operation";
      readonly operation: OperationKind;
    }
  | {
      readonly kind: "change";
      readonly change: string;
      readonly operation?: NamespacedName;
    };

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly locations: readonly DiagnosticLocation[];
  readonly notes?: readonly string[];
}

const assertLocation = (location: DiagnosticLocation): void => {
  if (location.kind === "adapter") assertNamespace(location.adapter);
  if (location.kind === "operation") assertNamespacedName(location.operation);
  if (location.kind === "change" && location.operation !== undefined) {
    assertNamespacedName(location.operation);
  }
};

export const defineDiagnostic = <const T extends Diagnostic>(value: T): T => {
  if (value.code.length === 0) throw new TypeError("Diagnostic code must not be empty.");
  if (value.message.length === 0) throw new TypeError("Diagnostic message must not be empty.");
  for (const location of value.locations) assertLocation(location);
  return immutableCopy(value);
};
