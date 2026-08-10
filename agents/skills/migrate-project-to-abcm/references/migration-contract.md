# Migration contract

Use `docs/plans/v0.1/migration-plan.md` as the runbook. The first self-hosting migration is this repository itself: root metadata is added in place, then the REST API must list and read it without exposing `.git`, `.abcm`, dependency, or build directories.
