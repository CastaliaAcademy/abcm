import { AbcmError } from "./errors.js";

export type AbcmOperation =
  | "authentication"
  | "sync.pairing.create"
  | "sync.pairing.redeem"
  | "sync.device.revoke"
  | "sync.preview"
  | "sync.changes"
  | "sync.apply"
  | "sync.conflict.create"
  | "sync.conflict.resolve"
  | "file.delete"
  | "file.move"
  | "file.write"
  | "scope_map.scan"
  | "scope_path.resolve"
  | "context.build"
  | "documentation.preview"
  | "documentation.apply"
  | "documentation.sync"
  | "documentation.cutover";

export type AbcmOperationOutcome = "success" | "denied" | "conflict" | "cancelled" | "failure";

export interface AbcmAuditEvent {
  schemaVersion: 1;
  occurredAt: string;
  operation: AbcmOperation;
  outcome: AbcmOperationOutcome;
  durationMs: number;
  workspaceId?: string;
  principalId?: string;
  errorCode?: string;
}

export type AbcmMetricName =
  | "abcm_authentication_total"
  | "abcm_file_mutation_total"
  | "abcm_scope_map_scan_duration_ms"
  | "abcm_scope_path_resolution_duration_ms"
  | "abcm_context_build_duration_ms"
  | "abcm_context_bundle_tokens"
  | "abcm_context_bundle_omissions"
  | "abcm_documentation_operation_duration_ms"
  | "abcm_documentation_sync_conflicts";

export interface AbcmMetricPoint {
  name: AbcmMetricName;
  value: number;
  unit: "count" | "ms" | "tokens";
  operation: AbcmOperation;
  outcome?: AbcmOperationOutcome;
}

export interface AbcmObservability {
  audit(event: Readonly<AbcmAuditEvent>): void | Promise<void>;
  metric(point: Readonly<AbcmMetricPoint>): void | Promise<void>;
}

export class InMemoryAbcmObservability implements AbcmObservability {
  readonly auditEvents: AbcmAuditEvent[] = [];
  readonly metricPoints: AbcmMetricPoint[] = [];

  audit(event: Readonly<AbcmAuditEvent>): void {
    this.auditEvents.push({ ...event });
  }

  metric(point: Readonly<AbcmMetricPoint>): void {
    this.metricPoints.push({ ...point });
  }
}

function outcome(error: unknown): AbcmOperationOutcome {
  if (!(error instanceof AbcmError)) return "failure";
  if (error.code === "ACCESS_DENIED" || error.code === "AUTHENTICATION_REQUIRED" || error.code === "CUTOVER_APPROVAL_REQUIRED") return "denied";
  if (error.code.includes("CANCELLED")) return "cancelled";
  if (error.code.includes("CONFLICT") || error.code.includes("MISMATCH") || error.code.includes("AMBIGUOUS")) return "conflict";
  return "failure";
}

export interface ObserveOperationOptions {
  operation: AbcmOperation;
  workspaceId?: string;
  principalId?: string;
  successMetrics?: (result: unknown) => readonly AbcmMetricPoint[];
  durationMetric?: AbcmMetricName;
  now?: () => number;
  clock?: () => Date;
}

function safely(deliver: () => void | Promise<void>): void {
  try {
    void Promise.resolve(deliver()).catch(() => undefined);
  } catch {
    // Telemetry is deliberately non-interfering with canonical operations.
  }
}

export function emitAudit(observability: AbcmObservability | undefined, event: AbcmAuditEvent): void {
  if (observability !== undefined) safely(() => observability.audit(event));
}

export function emitMetric(observability: AbcmObservability | undefined, point: AbcmMetricPoint): void {
  if (observability !== undefined) safely(() => observability.metric(point));
}

export function observeOperation<T>(
  observability: AbcmObservability | undefined,
  options: ObserveOperationOptions,
  action: () => Promise<T>,
): Promise<T> {
  if (observability === undefined) return action();
  return (async () => {
    const now = options.now ?? (() => performance.now());
    const started = now();
    try {
      const result = await action();
      const durationMs = Math.max(0, now() - started);
      emitAudit(observability, {
        schemaVersion: 1,
        occurredAt: (options.clock ?? (() => new Date()))().toISOString(),
        operation: options.operation,
        outcome: "success",
        durationMs,
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
        ...(options.principalId === undefined ? {} : { principalId: options.principalId }),
      });
      if (options.durationMetric !== undefined) emitMetric(observability, { name: options.durationMetric, value: durationMs, unit: "ms", operation: options.operation, outcome: "success" });
      for (const point of options.successMetrics?.(result) ?? []) emitMetric(observability, point);
      return result;
    } catch (error) {
      const durationMs = Math.max(0, now() - started);
      const operationOutcome = outcome(error);
      emitAudit(observability, {
        schemaVersion: 1,
        occurredAt: (options.clock ?? (() => new Date()))().toISOString(),
        operation: options.operation,
        outcome: operationOutcome,
        durationMs,
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
        ...(options.principalId === undefined ? {} : { principalId: options.principalId }),
        ...(error instanceof AbcmError ? { errorCode: error.code } : {}),
      });
      if (options.durationMetric !== undefined) emitMetric(observability, { name: options.durationMetric, value: durationMs, unit: "ms", operation: options.operation, outcome: operationOutcome });
      throw error;
    }
  })();
}
