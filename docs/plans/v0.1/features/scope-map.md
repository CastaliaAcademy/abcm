# Feature plan — first ScopeMap slice

Requirements: FS-001..005, SCP-001..003, MAP-001/002/003/005/006/008/011/013.

Implement root workflow validation, direct-child scope discovery, exact rank transitions, invalid-branch diagnostics, deterministic digest, readiness warning, agent/admin projections, and ordinary-source exclusion. SQLite publication and incremental watchers are deferred; revision is immutable in memory per scan.
