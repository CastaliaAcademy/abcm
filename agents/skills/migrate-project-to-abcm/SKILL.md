---
name: migrate-project-to-abcm
description: Preview, execute, and verify migration of an existing project into an ABCM workspace without modifying the source during preview. Use when adopting ABCM metadata, importing a project tree through REST, validating scope hierarchy, or rehearsing rollback.
metadata:
  abcm-skill-strategy: manual
  abcm-task-types: project-migration,workspace-import
  abcm-version: "0.5"
---

# Migrate Project To ABCM

Perform migrations as previewed, checksum-bound operations.

## Workflow

1. Inventory the source without writes and classify reserved, ignored, managed-document, and ordinary-source paths.
2. Produce a migration manifest with source/target paths, size, checksum, operation, and collision outcome.
3. Require a valid root workflow `scope.yaml` and DomainLanguageConvention before apply.
4. Apply through the same WorkspaceFileService used by REST; do not bypass path and concurrency checks.
5. Rescan and compare file counts/checksums plus ScopeMap diagnostics.
6. Stop on collision, traversal, symlink, checksum mismatch, or invalid root.
7. Retain the manifest and verification evidence for rollback/audit.

Read [references/migration-contract.md](references/migration-contract.md) before preview or apply.
