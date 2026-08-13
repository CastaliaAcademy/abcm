# PLAN-0015 evidence — skill connection resolution

Date: 2026-08-13
Result: PASS

## RED and GREEN

- RED began without SkillDescriptor state, connection contracts, strategy resolver, legacy diagnostics, or post-selection materialization.
- Indexing stores strict frontmatter metadata and checksum only; no SKILL.md or script body appears in MapRevision.
- Global, scope, by-link, by-description, and manual strategies connected under their independent conditions.
- Local duplicate precedence selected the service-owned descriptor; required kinds/tags/links became additive SkillContextRequirement records.
- Manual omission, unresolved required link, equal description scores, and lower-scope global declarations failed or excluded as required.
- Legacy context-strategy and removed context-base emitted distinct diagnostics.

## Regression and artifact

- Targeted map/store/connection gate: 20 tests, 86 assertions, all passed.
- Full isolated Linux Docker `bun run check`: 101 tests, 395 assertions, all passed.
- `bun run build`: passed.
- Image: `abcm-mcp-server:skill-connections`.
- Manifest list: `sha256:3d78112938b713c54634a70b491a034af9e672cd3c31c0ab66c847bfe4486c7e`.
- Production `dist` smoke indexed two body-free descriptors, connected global and manual skills, checksum-loaded their two SKILL.md bodies, and recorded independent reasons.

## Boundaries

- Scripts remain separate ExecutableResourceRecord entries; connection does not activate or authorize them.
- SkillDescriptor normalized SQLite tables, dependency execution, semantic provider integration, and buildTaskContext exposure remain later work.
- Existing `abcm-local` and `abcm-tunnel` containers were not replaced or restarted.
