import { CONTEXT_SELECTION_POLICY_VERSION } from "../context/context-builder.js";
import type { ContextFingerprintCatalog } from "../context/types.js";
import { AbcmError } from "../core/errors.js";
import type { ContextPrincipal } from "../domain-language/types.js";
import type {
  ContextFeedbackCatalog,
  ContextFeedbackProposal,
  ContextFeedbackSubmission,
} from "./context-feedback.js";

export class ContextFeedbackService {
  readonly #feedback: ContextFeedbackCatalog;
  readonly #fingerprints: ContextFingerprintCatalog;
  readonly #principal: ContextPrincipal;

  constructor(feedback: ContextFeedbackCatalog, fingerprints: ContextFingerprintCatalog, principal: ContextPrincipal) {
    this.#feedback = feedback;
    this.#fingerprints = fingerprints;
    this.#principal = principal;
  }

  propose(input: ContextFeedbackSubmission): ContextFeedbackProposal {
    const fingerprint = this.#ownedFingerprint(input.workspaceId, input.fingerprintId);
    if (!fingerprint.fingerprint.selectedDocuments.some(document => document.documentId === input.documentId)) {
      throw new AbcmError("CONTEXT_DOCUMENT_NOT_FOUND", "Context document is unavailable in this fingerprint.");
    }
    return this.#feedback.recordContextFeedback({
      ...input,
      principalId: this.#principal.principalId,
      bundleDigest: fingerprint.bundleDigest,
      mapRevision: fingerprint.fingerprint.mapRevision,
      basePolicyVersion: CONTEXT_SELECTION_POLICY_VERSION,
    });
  }

  list(workspaceId: string, fingerprintId: string): ContextFeedbackProposal[] {
    this.#ownedFingerprint(workspaceId, fingerprintId);
    return this.#feedback.listContextFeedback(workspaceId, fingerprintId);
  }

  #ownedFingerprint(workspaceId: string, fingerprintId: string) {
    const fingerprint = this.#fingerprints.getContextFingerprint(workspaceId, fingerprintId);
    if (fingerprint === undefined || fingerprint.principalId !== this.#principal.principalId) {
      throw new AbcmError("CONTEXT_FINGERPRINT_NOT_FOUND", "Context fingerprint is unavailable in this workspace.");
    }
    return fingerprint;
  }
}
