# ADR-0001 — Bun SQLite adapter for rebuildable map state

Status: accepted for alpha
Date: 2026-08-12

## Decision

The domain-facing map repository is transport- and database-independent. The reference Bun runtime uses `bun:sqlite`, one database per workspace at `.abcm/abcm.sqlite`, rollback journaling (`DELETE`), versioned migrations, short transactions, and fencing tokens.

Each SQLite-enabled process uses a unique owner id, a renewable per-database owner lease, and an owner fencing token. Heartbeat loss fences subsequent reads and writes through that adapter; graceful close releases only the matching owner/token tuple.

SQLite stores serialized derived revisions and their publication metadata, never the only copy of authored content. Deleting the database and scanning the canonical filesystem rebuilds it.

## Consequences

- The initial adapter is supported by the current Bun runtime and package engine contract.
- A future Node.js runtime must provide an adapter with equivalent transaction and locking semantics before Node is declared supported.
- WAL is deliberately disabled for portability to network-mounted workspace profiles.
- A second REST/stdio process cannot enable SQLite for the same workspace; tunneled MCP should share the owning HTTP runtime before persistence is enabled for both adapters.
- This slice persists map revisions, leases, and scan sessions; the remaining M2 entity repositories stay explicit follow-up work.
