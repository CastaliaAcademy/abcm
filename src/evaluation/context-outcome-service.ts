import { AbcmError } from "../core/errors.js";
import type { ContextFingerprintCatalog } from "../context/types.js";
import type { ContextPrincipal } from "../domain-language/types.js";
import type {
  ContextOutcomeCatalog,
  ContextOutcomeReceipt,
  ContextOutcomeSubmission,
} from "./context-outcome-receipt.js";

export class ContextOutcomeService {
  readonly #outcomes: ContextOutcomeCatalog;
  readonly #fingerprints: ContextFingerprintCatalog;
  readonly #principal: ContextPrincipal;

  constructor(outcomes: ContextOutcomeCatalog, fingerprints: ContextFingerprintCatalog, principal: ContextPrincipal) {
    this.#outcomes = outcomes;
    this.#fingerprints = fingerprints;
    this.#principal = principal;
  }

  record(input: ContextOutcomeSubmission): ContextOutcomeReceipt {
    const fingerprint = this.#ownedFingerprint(input.workspaceId, input.fingerprintId);
    if (fingerprint.fingerprint.execution?.runId !== undefined && fingerprint.fingerprint.execution.runId !== input.runId) {
      throw new AbcmError("CONTEXT_OUTCOME_CONFLICT", "Outcome run identity does not match the fingerprint execution binding.");
    }
    return this.#outcomes.recordContextOutcome(input);
  }

  list(workspaceId: string, fingerprintId: string): ContextOutcomeReceipt[] {
    this.#ownedFingerprint(workspaceId, fingerprintId);
    return this.#outcomes.listContextOutcomes(workspaceId, fingerprintId);
  }

  #ownedFingerprint(workspaceId: string, fingerprintId: string) {
    const fingerprint = this.#fingerprints.getContextFingerprint(workspaceId, fingerprintId);
    if (fingerprint === undefined || fingerprint.principalId !== this.#principal.principalId) {
      throw new AbcmError("CONTEXT_FINGERPRINT_NOT_FOUND", "Context fingerprint is unavailable in this workspace.");
    }
    return fingerprint;
  }
}
