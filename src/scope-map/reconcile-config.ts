import type { ScopeMapReconcileOptions } from "./reconcile-coordinator.js";

export const DEFAULT_SCOPE_MAP_RECONCILE_DEBOUNCE_MS = 50;
export const DEFAULT_SCOPE_MAP_FULL_RECONCILE_INTERVAL_MS = 300_000;

type Environment = Readonly<Record<string, string | undefined>>;

function optionalSafeInteger(
  environment: Environment,
  name: string,
  minimum: number,
  expectation: string,
): number | undefined {
  const value = environment[name];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be a ${expectation}.`);
  return parsed;
}

export function parseScopeMapReconcileEnvironment(
  environment: Environment,
): Pick<ScopeMapReconcileOptions, "debounceMs" | "fullReconcileIntervalMs"> {
  const debounceMs = optionalSafeInteger(
    environment,
    "ABCM_SCOPE_MAP_RECONCILE_DEBOUNCE_MS",
    0,
    "non-negative safe integer",
  );
  const fullReconcileIntervalMs = optionalSafeInteger(
    environment,
    "ABCM_SCOPE_MAP_FULL_RECONCILE_INTERVAL_MS",
    1,
    "positive safe integer",
  );
  return {
    ...(debounceMs === undefined ? {} : { debounceMs }),
    ...(fullReconcileIntervalMs === undefined ? {} : { fullReconcileIntervalMs }),
  };
}
