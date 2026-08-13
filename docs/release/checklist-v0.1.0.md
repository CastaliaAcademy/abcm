# ABCM 0.1.0 release checklist

Status: local gates passed; authenticated documentation publication pending

- [x] Package/server version is `0.1.0`; Bun package manager is pinned.
- [x] Machine traceability covers 78 baseline requirements, 22 baseline acceptance scenarios, 196 extension requirements, and 56 extension acceptance scenarios.
- [x] Accepted ADR/RFC mutation and normative placement tests pass.
- [x] SQLite schema v8 migration preserves the active revision and adds nullable worker metadata.
- [x] Frozen install, typecheck, complete test suite (147 tests / 712 assertions), build, release check, and deterministic generated artifacts pass in the clean Docker gate.
- [x] High-severity dependency audit (no vulnerabilities), benchmark (112 scopes / 100 documents), and package dry run (116 files / 0.57 MB unpacked) pass.
- [x] No-cache production image builds and its composition root passes a final-image smoke test (`0.1.0`, schema v8, nullable worker metadata).
- [ ] Final release documents are published and reread byte-for-byte through the authenticated ABCM REST workspace.
- [x] External GitHub/package/image publication and running-container replacement remain unperformed.
