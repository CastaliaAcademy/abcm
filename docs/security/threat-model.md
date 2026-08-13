# ABCM 0.1 threat model

Status: implemented controls reviewed through PLAN-0026

## Trust boundaries

- Workspace and documentation-source bytes are untrusted authored input.
- REST/MCP callers are untrusted until the deployment authentication boundary resolves them to a configured principal.
- Connector roots, bearer credentials, access profiles, and telemetry sinks are deployment-owned configuration.
- `.abcm/abcm.sqlite` is rebuildable derived state owned by one fenced process; it is not shared application data.

## Threats and controls

| Threat | Control | Residual boundary |
|---|---|---|
| Path traversal, absolute/network path injection, symlink escape | Canonical relative paths, denied components, realpath checks, symlink rejection, atomic workspace writes | Deployment must mount only intended roots |
| Malicious YAML/frontmatter | Core-schema data-only parsing, duplicate/custom-tag/warning rejection, strict Zod schemas, alias expansion cap | Valid but semantically hostile prose remains untrusted context |
| Oversized files and request bodies | Per-workspace read/write/index/list limits and streamed REST body limit before allocation | Operators size limits for their workload |
| Executable-resource activation | Scripts are metadata-only `ExecutableResourceRecord` values with `activationStatus=required`; no server execution path exists | An external executor must enforce activation and permission decisions |
| Tenant/workspace leakage | Explicit workspace registry, scope permissions, bounded projections, no ordinary source catalog, no bodies in audit/metrics | Static reference principal is deployment-scoped, not an identity provider |
| DNS rebinding and cross-origin MCP use | Streamable HTTP validates Host and Origin against explicit allowlists before dispatch | Reverse proxy must preserve validated Host/Origin semantics |
| Stale bootstrap/revision and concurrent writes | Revision/checksum pinning, ETags, leases/fencing, abort boundaries, immutable fingerprints | Distributed multi-writer coordination is outside MVP |
| Secret/document disclosure through telemetry | Fixed field schemas; no arbitrary attributes, paths, headers, goals, document ids, bodies, or tokens; sink failures isolated | Sink transport/storage security belongs to deployment |
| Mutation of accepted decisions | REST, MCP, and library workspace mutations reject writes/deletes and overwrite-target moves for indexed accepted ADR/RFC content; checksum-preserving rename remains allowed | Direct host filesystem edits bypass the in-process service boundary; amendments require an operator workflow |

## Security invariants

- ABCM does not execute workspace scripts, YAML tags, Markdown, or frontmatter.
- Source repository files are never rewritten by mirror synchronization or cutover.
- Telemetry is diagnostic metadata, not an authored-content export path.
- A failed validation or stale pin cannot silently downgrade mandatory context or overwrite canonical bytes.
- Misplaced AgentRole, artifact, architecture, and PlantUML records remain visible as diagnostics but are excluded from the active document index.
