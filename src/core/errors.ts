export type AbcmErrorCode =
  | "REQUEST_INVALID"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_ALREADY_EXISTS"
  | "WORKSPACE_REGISTRATION_DISABLED"
  | "SCAN_LEASE_BUSY"
  | "SCAN_FENCING_STALE"
  | "DERIVED_STORE_CORRUPT"
  | "FILE_PATH_INVALID"
  | "FILE_PATH_FORBIDDEN"
  | "FILE_NOT_FOUND"
  | "FILE_ALREADY_EXISTS"
  | "FILE_CHECKSUM_MISMATCH"
  | "FILE_TOO_LARGE"
  | "FILE_TYPE_UNSUPPORTED"
  | "MAP_NOT_BUILT"
  | "SCOPE_MANIFEST_INVALID"
  | "WORKSPACE_ROOT_MUST_BE_WORKFLOW";

const HTTP_STATUS_BY_CODE: Record<AbcmErrorCode, number> = {
  REQUEST_INVALID: 400,
  WORKSPACE_NOT_FOUND: 404,
  WORKSPACE_ALREADY_EXISTS: 409,
  WORKSPACE_REGISTRATION_DISABLED: 503,
  SCAN_LEASE_BUSY: 409,
  SCAN_FENCING_STALE: 409,
  DERIVED_STORE_CORRUPT: 500,
  FILE_PATH_INVALID: 400,
  FILE_PATH_FORBIDDEN: 403,
  FILE_NOT_FOUND: 404,
  FILE_ALREADY_EXISTS: 409,
  FILE_CHECKSUM_MISMATCH: 412,
  FILE_TOO_LARGE: 413,
  FILE_TYPE_UNSUPPORTED: 415,
  MAP_NOT_BUILT: 409,
  SCOPE_MANIFEST_INVALID: 422,
  WORKSPACE_ROOT_MUST_BE_WORKFLOW: 422,
};

export class AbcmError extends Error {
  readonly code: AbcmErrorCode;
  readonly status: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: AbcmErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "AbcmError";
    this.code = code;
    this.status = HTTP_STATUS_BY_CODE[code];
    if (details !== undefined) this.details = details;
  }
}
