# Feature plan — REST file management

Requirements: RFM-001..008. Acceptance: AC-RFM-*.

## TDD sequence

1. RED safe-path normalization and denylist cases.
2. GREEN WorkspaceFileService list/read/write with SHA-256 metadata.
3. RED stale create/replace/delete and move collision cases.
4. GREEN atomic write, conditional mutation, move and directory creation.
5. RED REST contract/problem mapping and payload limit cases.
6. GREEN fetch-compatible REST handler.
7. RED filesystem/REST parity and reconciliation tests.
8. GREEN running-server E2E.

## Exclusions

No recursive delete, binary multipart upload, remote URL fetch, chmod/chown, archive extraction, or host paths outside the registered root.
