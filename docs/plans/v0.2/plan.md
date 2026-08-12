# PLAN-0003 — Managed workspace registration and first documentation import

Status: completed
Target: `0.2.0-alpha.1`
Completed: 2026-08-11
Normative sources: specification 0.5.0, REST workspace registration extension 0.1.0, and REST file management extension 0.1.0.

## Outcome

An authenticated operator can register `castalia-public` under a server-owned workspace store, create project scope `abcm`, and copy ABCM documentation into that project without modifying the source repository.

## Work units

1. WU-01 — dynamic registry and safe server-owned workspace provisioning.
2. WU-02 — `POST /v1/workspaces` contract and restart discovery.
3. WU-03 — local Docker store mount and real authenticated HTTP smoke.
4. WU-04 — checksum-bound preview/apply verification for ABCM documentation.
5. WU-05 — REST/MCP visibility and ScopeMap gate.

## Exclusions

No workspace deletion, arbitrary root registration, automatic source deletion, two-way sync, or durable SQLite catalog is included.

## Gate result

- Full Docker check: PASS — 44 tests, 123 assertions, 0 failures.
- Package build: PASS.
- Authenticated REST registration and restart discovery: PASS.
- Preview/apply/checksum verification: PASS — 29 files, 0 collisions, exact source/target parity.
- Connected MCP list/read/ScopeMap verification: PASS — ready workflow and project, no diagnostics.

Detailed evidence is stored in `artifacts/plans/PLAN-0003/evidence/`.
