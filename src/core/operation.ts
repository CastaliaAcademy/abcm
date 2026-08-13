import { AbcmError, type AbcmErrorCode } from "./errors.js";

export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export interface OperationDeadline {
  signal: AbortSignal;
  finish(): void;
  mapAbort(error: unknown): never;
}

export interface OperationDeadlineErrorMapping {
  label: string;
  timeoutCode: AbcmErrorCode;
  cancelledCode: AbcmErrorCode;
}

const MCP_DEADLINE_ERRORS: OperationDeadlineErrorMapping = {
  label: "MCP operation",
  timeoutCode: "MCP_OPERATION_TIMEOUT",
  cancelledCode: "MCP_OPERATION_CANCELLED",
};

export function createOperationDeadline(
  requestSignal: AbortSignal,
  timeoutMs: number,
  errors: OperationDeadlineErrorMapping = MCP_DEADLINE_ERRORS,
): OperationDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new AbcmError("REQUEST_INVALID", `${errors.label} timeout must be an integer from 1 through 300000 milliseconds.`);
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException(`${errors.label} timed out.`, "TimeoutError")), timeoutMs);
  timer.unref?.();
  const signal = AbortSignal.any([requestSignal, timeout.signal]);
  return {
    signal,
    finish: () => clearTimeout(timer),
    mapAbort(error: unknown): never {
      if (timeout.signal.aborted && !requestSignal.aborted) {
        throw new AbcmError(errors.timeoutCode, `${errors.label} exceeded its configured timeout.`);
      }
      if ((error instanceof DOMException && error.name === "AbortError") || requestSignal.aborted) {
        throw new AbcmError(errors.cancelledCode, `${errors.label} was cancelled.`);
      }
      throw error;
    },
  };
}
