# Runtime observability

Pass an `AbcmObservability` implementation as `createAbcmRuntime(..., { observability })`. The runtime emits a fixed, low-cardinality event model and does not select a vendor backend.

Audit events contain only schema version, time, operation, outcome, duration, optional workspace/principal ids, and a stable error code. They never contain request/response bodies, document paths or ids, goals, headers, bearer tokens, connector credentials, or arbitrary attributes.

Metric names are fixed:

- `abcm_authentication_total`
- `abcm_file_mutation_total`
- `abcm_scope_map_scan_duration_ms`
- `abcm_scope_path_resolution_duration_ms`
- `abcm_context_build_duration_ms`
- `abcm_context_bundle_tokens`
- `abcm_context_bundle_omissions`
- `abcm_documentation_operation_duration_ms`
- `abcm_documentation_sync_conflicts`

The bundled `InMemoryAbcmObservability` is intended for tests and local diagnostics. Production adapters should enqueue quickly; synchronous exceptions and rejected sink promises are isolated and cannot change the observed operation result.

`WorkspaceDefinition.maxIndexBytes` defaults to 1 MiB. A larger managed file is skipped before body allocation and produces a metadata-only `FILE_TOO_LARGE` map warning. This limit is independent of `maxReadBytes`, `maxWriteBytes`, request-body limits, and context token budgets.
