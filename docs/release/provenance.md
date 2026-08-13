# 0.1.0 package provenance

This repository prepares a local release candidate; it does not publish a package, image, Git tag, GitHub release, or attestation.

Reproducible inputs:

- Bun and package-manager pin: `bun@1.3.14`.
- Dependency lock: committed `bun.lock`, installed with `bun install --frozen-lockfile`.
- Builder image: `oven/bun:1.3.14` pinned by the Docker build base digest at build time.
- Package allowlist: `package.json#files`; generated output is `dist` from `tsc -p tsconfig.build.json`.
- SBOM: deterministic CycloneDX 1.6 document at `docs/release/sbom.cdx.json`, generated only from the lockfile.

Local release gate:

```bash
bun install --frozen-lockfile
bun run check
bun run build
bun run release:check
bun run traceability:check
bun pm pack --dry-run
bun audit --audit-level=high
```

Publication must add the final Git commit, package/archive digest, builder identity, signature/attestation location, and registry/GitHub URLs. Those external actions require explicit operator approval.
