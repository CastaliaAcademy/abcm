# PLAN-0015 verification plan

## Contract gates

- RED: SkillDescriptor index, connection types/resolver, five strategies, legacy diagnostics, and context requirements are absent.
- GREEN: all five strategies, local duplicate precedence, descriptor-only description match, additive requirements, and selected-body materialization pass.
- Negative: manual omission, unresolved required link, description tie, lower-scope global, stale skill checksum, invalid/lifecycle/access filters fail or exclude as specified.
- Disclosure: MapRevision contains descriptors but no SKILL.md bodies; results contain selected SKILL.md only and never script bytes.
- Regression: targeted tests, full `bun run check`, `bun run build`, production image, and production `dist` library smoke.
