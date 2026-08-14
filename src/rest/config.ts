export interface AbcmRestLimitOptions {
  maxRequestBodyBytes?: number;
  requestTimeoutMs?: number;
  maxRequestsPerMinute?: number;
}

export interface ResolvedAbcmRestLimitOptions {
  maxRequestBodyBytes: number;
  requestTimeoutMs: number;
  maxRequestsPerMinute: number;
}

export const DEFAULT_REST_LIMITS: ResolvedAbcmRestLimitOptions = {
  maxRequestBodyBytes: 1_048_576,
  requestTimeoutMs: 30_000,
  maxRequestsPerMinute: 600,
};

function integer(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  if (value > maximum) throw new Error(`${name} must not exceed ${maximum}.`);
  return value;
}

export function resolveRestLimitOptions(options: AbcmRestLimitOptions = {}): ResolvedAbcmRestLimitOptions {
  return {
    maxRequestBodyBytes: integer(
      "maxRequestBodyBytes",
      options.maxRequestBodyBytes ?? DEFAULT_REST_LIMITS.maxRequestBodyBytes,
      16_777_216,
    ),
    requestTimeoutMs: integer(
      "requestTimeoutMs",
      options.requestTimeoutMs ?? DEFAULT_REST_LIMITS.requestTimeoutMs,
      300_000,
    ),
    maxRequestsPerMinute: integer(
      "maxRequestsPerMinute",
      options.maxRequestsPerMinute ?? DEFAULT_REST_LIMITS.maxRequestsPerMinute,
      100_000,
    ),
  };
}

export function parseRestLimitEnvironment(environment: Record<string, string | undefined>): AbcmRestLimitOptions {
  const parse = (name: string): number | undefined => {
    const value = environment[name];
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
    return parsed;
  };
  return resolveRestLimitOptions({
    maxRequestBodyBytes: parse("ABCM_REST_MAX_REQUEST_BODY_BYTES") ?? DEFAULT_REST_LIMITS.maxRequestBodyBytes,
    requestTimeoutMs: parse("ABCM_REST_REQUEST_TIMEOUT_MS") ?? DEFAULT_REST_LIMITS.requestTimeoutMs,
    maxRequestsPerMinute: parse("ABCM_REST_MAX_REQUESTS_PER_MINUTE") ?? DEFAULT_REST_LIMITS.maxRequestsPerMinute,
  });
}
