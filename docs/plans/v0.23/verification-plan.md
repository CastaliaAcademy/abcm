# PLAN-0024 verification plan

1. RED: telemetry contracts and maxIndexBytes behavior fail before implementation.
2. Schema: serialized events contain only fixed fields and reject arbitrary data at the TypeScript boundary.
3. Confidentiality: known bearer/body sentinel values never occur in collected events.
4. Isolation: throwing sinks do not alter success or expected error results.
5. Metrics: scan, resolver, bundle budget, sync conflict, file mutation, and authentication outcomes are observed.
6. Oversize: indexer skips body reads and publishes FILE_TOO_LARGE while valid siblings survive.
7. Parser: aliases/custom tags/frontmatter cannot execute code and bounded inputs remain deterministic.
8. Final: full check/build, Docker image build, and final-image import smoke pass.
