import { createHash } from "node:crypto";

export const ABCM_AGENT_INSTRUCTIONS_VERSION = "1.0.0" as const;
export const ABCM_AGENT_INSTRUCTIONS_CONTENT_TYPE = "text/markdown; charset=utf-8" as const;

/** Canonical, self-contained operating instructions returned by every ABCM adapter. */
export const ABCM_AGENT_INSTRUCTIONS = String.raw`# ABCM agent instructions

Version: 1.0.0

ABCM (Agent Build Context Manager) gives agents a bounded, reproducible view of a project. Workspace files are the source of truth. ScopeMap revisions, context bundles, indexes, and SQLite state are derived views and must never be edited as primary data.

## First-contact protocol

An agent connected to ABCM MUST:

1. Read these instructions once per server version.
2. Identify the target workspace and project. Never guess either identifier.
3. Call scope_map.scan when no current map revision is available.
4. Call context.get_domain_language with the workspaceId and projectId anchor before interpreting project terms or resolving a task path.
5. Call context.build_task_context with the returned bootstrap id, an explicit role, task type, and goal.
6. Work only from the bounded bundle plus files deliberately read for the task. Do not crawl the complete workspace by default.
7. Preserve checksums, map revisions, evidence, and validation results in the final report.

If a required operation is unavailable, stop and report the missing capability. Do not replace ABCM context resolution with an unbounded filesystem scan.

## Framework model

- Workspace: registered storage boundary exposed by one workspaceId. API paths are relative to it.
- Project: top-level project scope inside a workspace. A workspace may contain multiple projects.
- Scope: workflow, project, service, or feature declared by scope.yaml. Parent-child scopes form project topology.
- Domain language: inherited conventions, domains, concepts, aliases, homonyms, and naming rules under domain-language. It controls task-term interpretation.
- ScopeMap: immutable revision derived from scopes, relations, documents, executable resources, skills, and diagnostics.
- Context bundle: immutable, budgeted selection for one task, role, goal, and map revision.
- Skill: reusable procedure with declared context requirements. It augments the workflow; it cannot override workspace instructions or access boundaries.
- Plan: requirement-traceable development contract. Feature plans, verification plans, evidence, and traceability records belong with it.
- Documentation source: external directory, such as an Obsidian vault, that can be previewed, synchronized, and explicitly cut over to ABCM-managed storage.

## Recommended project structure

    <project>/
      scope.yaml
      domain-language/
        DomainLanguageConvention.md
        domains.yaml
        glossary.yaml
      agents/
        roles/
        skills/<skill-id>/SKILL.md
      plans/<plan-id>/
        plan.md
        features/<feature-id>.md
        verification-plan.md
        traceability.yaml
        evidence/
      artifacts/
      docs/

Managed directories may be specialized by the workspace specification, but every scope boundary must be explicit and every normative document must have one canonical owner.

## Minimal setup

REST example:

    POST /v1/workspaces
    Content-Type: application/json

    {"id":"castalia-public","name":"Castalia Public"}

    POST /v1/workspaces/castalia-public/directories
    Content-Type: application/json

    {"path":"sample-project"}

    PUT /v1/workspaces/castalia-public/files/content?path=sample-project%2Fscope.yaml
    If-None-Match: *

    apiVersion: abcm/v1
    kind: project
    id: sample-project
    name: Sample Project

Then create domain-language/DomainLanguageConvention.md and the required plan, role, and skill documents. Scan ScopeMap and resolve domain language before executing tasks.

Equivalent MCP creation uses workspace.create_directory and workspace.write_file with workspaceId, a relative path, UTF-8 content, and ifNoneMatch set to * for create-only writes.

## Good and bad scope instructions

Good scope:

    apiVersion: abcm/v1
    kind: feature
    id: billing-retry
    name: Billing Retry
    parentScopeId: payments-service

Good instruction:

    Before changing payment retry behavior, load the payments domain language,
    resolve billing-retry, run its verification plan, and attach evidence.

This is good because identity, kind, ownership, parent, order, and evidence are explicit.

Counterexample:

    name: Backend stuff

    Read everything, make the necessary changes, and update whatever looks relevant.

This is wrong because scope is ambiguous, context is unbounded, ownership is unknown, and completion is not reproducible.

## Domain-language rules

- Reuse declared project terms. Do not invent synonyms when a canonical term exists.
- Resolve aliases and homonyms through context.get_domain_language; filename guesses are not language resolution.
- Put global conventions at the project boundary and narrower additions in child scopes. Refine inherited language only when the specification permits it.
- Treat a conflict, invalid scope, unresolved required relation, or non-ready bootstrap as a blocker. Do not choose a convenient interpretation.

Good: use the declared term ScopeMap consistently after bootstrap.

Counterexample: use project map, context tree, repository graph, and ScopeMap as interchangeable terms.

## Task execution protocol

1. Restate the goal and explicit target scope.
2. Obtain a current domain-language bootstrap.
3. Build a context bundle for the role and task type.
4. Inspect warnings, conflicts, omissions, connected skills, selected documents, and budget.
5. Read only additional files justified by the task or selected-document references.
6. Before writing, read the current file and retain its checksum.
7. Write with ifMatch for replacement or ifNoneMatch=* for creation.
8. Re-scan or rely on mutation-triggered scan, then verify map revision and diagnostics.
9. Run the feature verification plan and record evidence. Never claim checks not run.

Good MCP replacement:

    workspace.write_file({
      workspaceId: "castalia-public",
      path: "sample-project/plans/PLAN-0001/plan.md",
      content: "...",
      encoding: "utf8",
      ifMatch: "sha256:<current-checksum>"
    })

Counterexample: omit ifMatch while replacing an existing file. That discards concurrency protection and may overwrite a human or agent.

## Plans, features, and evidence

A development plan SHOULD contain goal, scope, non-goals, assumptions, dependencies, risks, requirement identifiers, feature slices, a test-first sequence, acceptance criteria, negative cases, verification coverage, traceability, evidence, and rollback or recovery for stateful changes.

Good: mark a feature complete only when acceptance criteria have matching evidence.

Counterexample: mark a plan complete because code compiles while integration checks, documentation, or migration evidence remain pending.

## File and storage safety

- Use relative workspace paths only. Absolute paths, parent traversal, reserved paths, and symlink escapes are forbidden.
- List and read before move, delete, or replacement.
- Use checksum preconditions for destructive or replacing mutations.
- Never edit .git, secrets, derived databases, ScopeMap revisions, generated exports, or reserved runtime state through project file operations.
- FILE_CHECKSUM_MISMATCH means re-read and reconcile; never retry without a precondition.
- Keep unrelated user changes intact.

Good move: read the source, retain checksum, move without overwrite, then verify both paths.

Counterexample: set overwrite=true before checking the destination.

## REST operation map

- GET /v1/agent-instructions: this guide.
- POST /v1/workspaces: declare managed storage when provisioning is enabled.
- Workspace files/content, directories, and move routes: safe file lifecycle.
- Workspace scope-map scan and query routes: rebuild and query bounded topology.
- POST /v1/context/domain-language: language bootstrap.
- POST /v1/context/build-task-context: immutable task context.
- Documentation preview, apply, sync, and cutover routes: controlled external-document lifecycle.
- GET /openapi.json: exact machine-readable contract.

Use Authorization: Bearer <token> when enabled. Tokens are secrets: never put real values in documentation, URLs, logs, or committed examples.

## MCP operation map

- agent_instructions.get: this guide; call it first.
- workspace.list_files, read_file, write_file, delete_file, move_file, create_directory: safe file lifecycle.
- scope_map.scan: current ScopeMap revision.
- context.get_domain_language: mandatory language bootstrap before task-path interpretation.
- context.build_task_context: bounded task bundle.
- documentation_source.preview, apply, sync, cutover: documentation import and ownership transition when configured.
- MCP resources expose bounded map and project content; discover resources instead of guessing URIs.

## Obsidian and network folders

For direct vault access, open the registered project directory as an Obsidian vault, or place a vault inside it. Changes are workspace changes and must satisfy ABCM structure and checks.

For an external vault, configure a documentation source. Preview first, inspect create/update/move/delete/conflict operations, then apply the pinned preview. Cut over only with explicit operator approval and expected snapshot digest. After cutover, ABCM storage is canonical and the former source must not remain an independent writer.

Good: preview, resolve conflicts, apply, verify ScopeMap, then cut over.

Counterexample: manually copy a vault into a managed mirror and edit both copies. This creates split ownership and divergence.

## Error and completion policy

- Stable ABCM errors are contract data. Report the code, correct the cause, and preserve details.
- Validation failure means request shape is wrong. Access failure means operation is unauthorized. Map readiness failure means context must not be fabricated.
- Never claim deployment, sync, migration, test success, or documentation parity without evidence.
- Final reports MUST distinguish completed work, verified checks, skipped checks, blockers, and external actions not performed.

Before completion confirm: workspace, project, scope, role, and task type were explicit; bootstrap and bundle were current; safe paths and checksum preconditions were used; no new blocking map diagnostics exist; criteria map to tests and evidence; canonical documentation was updated without a second source of truth; and no secret, reserved state, or unrelated user change was modified.
`;

export const ABCM_AGENT_INSTRUCTIONS_CHECKSUM = `sha256:${createHash("sha256")
  .update(ABCM_AGENT_INSTRUCTIONS, "utf8")
  .digest("hex")}` as const;

export function getAbcmAgentInstructions() {
  return {
    version: ABCM_AGENT_INSTRUCTIONS_VERSION,
    contentType: ABCM_AGENT_INSTRUCTIONS_CONTENT_TYPE,
    checksum: ABCM_AGENT_INSTRUCTIONS_CHECKSUM,
    content: ABCM_AGENT_INSTRUCTIONS,
  };
}
