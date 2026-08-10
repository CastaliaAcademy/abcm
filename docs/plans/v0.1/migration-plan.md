# Migration plan — current repository

## Preview

- Treat this repository root as one workflow scope `abcm-development`.
- Add `scope.yaml`, DomainLanguageConvention, structured domain files, minimal config, roles, and skills.
- Do not move source files in the first migration.
- Exclude `.git`, `.abcm`, `node_modules`, `dist`, `coverage`, build output, and secrets from REST/file index disclosure.

## Apply and verify

1. Validate root manifest and domain-language readiness.
2. Start the reference REST server with workspace id `self` and this root.
3. List root files and read `scope.yaml` through REST.
4. Scan ScopeMap; require one valid workflow root and no fatal diagnostic.
5. Create/update/delete a temporary managed test file through REST with checksum guards.
6. Remove only the test file; source project content remains in place.

Rollback consists of reverting ABCM metadata files; no source relocation occurs.
