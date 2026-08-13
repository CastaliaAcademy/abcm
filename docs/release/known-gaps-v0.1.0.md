# ABCM 0.1.0 known gaps and non-goals

The 0.5.0 normative source is still marked draft. The 0.1.0 release candidate implements every MUST/MUST_NOT and acceptance scenario represented by the release traceability gate; this register records optional choices and explicit product boundaries.

## Optional requirements

- `DLC-004` is implemented: unknown free keywords may contribute only non-authoritative retrieval hints after canonical domain-language validation.
- `MAP-014` is not selected by default: the optional SourceLocatorIndex is disabled. `MAP-015` remains enforced because no source bodies enter ScopeMap or ContextBundle metadata.
- The baseline and release extensions declare no `SHOULD` requirements.

## Runtime and deployment boundaries

- The supported reference runtime is Bun 1.3.14 or newer. Node.js support is not claimed because the reference adapter uses `bun:sqlite`.
- Static bearer authentication maps to one deployment-owned principal. External IdP/tenant provisioning and durable audit storage are not included.
- File notifications are not required for correctness; periodic full reconciliation handles missed network-folder events. Automatic host watchers are not packaged.
- Accepted ADR/RFC immutability is enforced at REST, MCP, and `WorkspaceFileService` boundaries. Direct filesystem edits by host users cannot be prevented by this library.
- Executable resources are indexed as inert metadata; ABCM does not activate or execute scripts, source code, YAML, Markdown, or an LLM runtime.
- Documentation synchronization is one-way. Distributed multi-writer coordination, automatic two-way sync, and full authored-document versioning remain out of scope.
- Obsidian works through a mounted/network directory source today. A separately packaged public Obsidian community plugin is not part of 0.1.0; a private plugin can use the authenticated REST API.

## Publication boundary

The repository contains a locally verified release candidate only. No GitHub push/tag/release, package registry publication, image registry publication, attestation, production deployment, or replacement of an already running container is implied by the local gate.
