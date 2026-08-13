import { AbcmError } from "./errors.js";

export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export interface OperationDeadline {
  signal: AbortSignal;
  finish(): void;
  mapAbort(error: unknown): never;
}

export function createOperationDeadline(requestSignal: AbortSignal, timeoutMs: number): OperationDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new AbcmError("REQUEST_INVALID", "MCP operation timeout must be an integer from 1 through 300000 milliseconds.");
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException("MCP operation timed out.", "TimeoutError")), timeoutMs);
  timer.unref?.();
  const signal = AbortSignal.any([requestSignal, timeout.signal]);
  return {
    signal,
    finish: () => clearTimeout(timer),
    mapAbort(error: unknown): never {
      if (timeout.signal.aborted && !requestSignal.aborted) {
        throw new AbcmError("MCP_OPERATION_TIMEOUT", "MCP operation exceeded its configured timeout.");
      }
      if ((error instanceof DOMException && error.name === "AbortError") || requestSignal.aborted) {
        throw new AbcmError("MCP_OPERATION_CANCELLED", "MCP operation was cancelled.");
      }
      throw error;
    },
  };
}
