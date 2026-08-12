# План разработки ABCM MVP

Статус: in progress
Нормативная база: `docs/spec/abcm-mvp-agent-spec-v0.5.yaml`, версия 0.5.0, draft; `docs/spec/extensions/rest-file-management-v0.1.yaml`
Цель: библиотека MCP-сервера с transport-independent ядром; MCP и REST являются адаптерами одних use case.

## 1. Границы MVP

В MVP входят FileWorkspace, управление разрешёнными project files через filesystem и REST, ScopeMap, DomainLanguageBootstrap, EffectiveDomainLanguage, детерминированное подключение Agent Skills, ContextBundle/ContextFingerprint, односторонняя синхронизация документации, MCP и REST. Не входят LLM runtime, выполнение исходного кода, VCS/CI hosting, двусторонняя синхронизация, полное версионирование документов и distributed multi-writer coordination.

Обязательная совместимость MCP: ревизия 2025-11-25 из спецификации. SDK v2 допускается использовать в dual-protocol режиме, но поддержка более новой ревизии не должна менять контракт ABCM 0.5.

## 2. Архитектурные границы

```text
MCP resources/tools ----\\
                        application use cases ---- domain model
REST handlers ----------/          |                    |
                                    |                    +-- policies/resolvers
                                    +-- ports
                                         |-- filesystem (canonical content)
                                         |-- SQLite (derived/rebuildable state)
                                         |-- documentation connectors
                                         +-- clock/hash/access/event adapters
```

Принципы:

- Файловая система — источник истины; `.abcm/abcm.sqlite` пересобираема.
- Один процесс владеет SQLite; на network filesystem запрещён WAL.
- Публикация MapRevision и переключение mirror -> managed атомарны.
- MCP/REST не содержат правил выбора контекста и не обходят access checks.
- Полная ScopeMap и обычные исходники не попадают в ContextBundle по умолчанию.
- Все публичные схемы и ошибки трассируются до requirement/acceptance id спецификации.

## 3. Этапы реализации

### M0. Контракт и тестовый каркас

Результат: исполняемая матрица требований до реализации поведения.

- Зафиксировать JSON/TypeScript-схемы публичных сущностей, запросов, ответов и кодов ошибок.
- Ввести traceability manifest: `requirement id -> unit/contract/integration/acceptance tests`.
- Подготовить fixture workspaces: минимальный valid tree, каждая invalid hierarchy, duplicate ids, missing convention, mirror/cutover cases.
- Добавить CI для typecheck, unit, integration, package build и dependency audit.
- Gate: все 28 acceptance scenarios представлены пропущенными/красными тестами с явными ссылками на AC-id; публичные схемы проходят snapshot review.

### M1. FileWorkspace и безопасный I/O

Результат: детерминированное чтение/запись канонического workspace.

- Реализовать нормализацию относительных путей, reserved names и default ignore/classification rules.
- Парсить `scope.yaml`, frontmatter, configuration и DomainLanguageConvention без исполнения содержимого.
- Реализовать temp-file + flush/fsync policy + atomic rename + conflict detection.
- Запретить traversal, absolute network paths в документах и выход через symlink из workspace root.
- Gate: FS-001..010, SCP-001..003; property tests путей и атомарной записи.

### M2. SQLite derived store и миграции

Результат: rebuildable storage с одним владельцем и versioned schema.

- Таблицы для leases/sessions, revisions, scopes, relations, files/documents, resources, diagnostics, provenance, sync runs, tombstones, bundles/fingerprints.
- Owner lock, fencing token, rollback journal для network storage, транзакционные repository ports.
- Команда полного rebuild после удаления базы; запрет хранения единственной копии authored content.
- Gate: AC-001, owner-conflict tests, crash/restart tests, проверка `journal_mode != WAL` для network profile.

### M3. buildScopeMap и reconcileScopeMap

Результат: атомарно публикуемая, воспроизводимая карта областей.

- Реализовать MAP-P0..P6: lease, root validation, direct-child discovery, rank topology, classification/indexing, relations/readiness, staged publication.
- InvalidBranch сохранять для admin projection, исключать из resolver graph и продолжать другие ветки.
- Разделить DocumentRecord, ExecutableResourceRecord и opt-in SourceLocatorRecord; не индексировать тела обычного кода.
- Реализовать debounce incremental reconcile и обязательную периодическую full reconciliation.
- Канонизировать вход digest так, чтобы неизменённый workspace давал эквивалентный digest.
- Gate: MAP-001..015, AC-002/003/007, AC-MAP-ATOMIC, AC-JS-SOURCE-IGNORED, AC-SKILL-SCRIPT-RESOURCE.

### M4. ScopeMapProjection и доступ

Результат: bounded agent/admin views без утечки тел документов.

- Permission model: discover, metadata, full-map, context build, document/resource read.
- Реализовать root/depth/includeInvalid bounds и минимальную path-only цепочку предков.
- Agent view: readiness, relevant warnings, relations summaries, resolver entrypoints; admin view: diagnostics/counts/sync status.
- Gate: MAP-001..003/009..011, permission matrix и negative disclosure tests.

### M5. DomainLanguageBootstrap и path resolver

Результат: канонизация терминов предшествует выбору target scope.

- Merge workflow -> project для bootstrap; привязать bootstrap к principal, anchor, revision, checksums и expiry.
- Разрешать domains/terms/aliases/homonyms/locked concepts с типизированными ошибками.
- Детерминированные scoring tiers: exact ids/links, artifact ownership, repository paths, canonical concepts, relations, semantic/keyword fallback.
- После выбора пути merge service/feature conventions; разрешить не более одного повторного path-resolution pass.
- Gate: DLC-001..006, CTX-010, AC-005, AC-LOCAL-DOMAIN-RERESOLVE; golden scoring fixtures.

### M6. Skill discovery и connection resolution

Результат: стратегии `global`, `scope`, `by-link`, `by-description`, `manual` подключают skills, но не выбирают весь документный контекст.

- Индексировать compact SkillDescriptor; тело SKILL.md загружать только после подключения.
- Реализовать precedence, local-to-public resolution, compatibility/lifecycle/access/role/task filters, ambiguity threshold и dedup с сохранением всех reasons.
- Поддержать legacy `abcm-context-strategy` с warning до 1.0; игнорировать `abcm-context-base` с отдельным warning.
- Scripts/references/assets оставить отдельными адресуемыми ресурсами с activation/permission checks.
- Gate: AGT-001..014 и AC-SKILL-*.

### M7. buildTaskContext

Результат: immutable bounded ContextBundle и воспроизводимый ContextFingerprint.

- Реализовать CTX-P0..P12: input pinning, intent, search universe, path, local language, skills, config merge, mandatory/optional collection, lifecycle/dedup/conflicts, projections, budget, materialization.
- Mandatory документы резервировать первыми; unreadable mandatory и hard-limit overflow должны завершать build ошибкой.
- Для каждого документа фиксировать SelectionReason, DocumentProjection, source id/checksum; summary помечать non-authoritative.
- Fingerprint хранит фактически materialized projection, revisions/config/digests/skills, но не дублирует тела.
- Gate: CTX-001..016, AC-004/008 и все AC-CONTEXT-*; deterministic digest и budget boundary tests.

### M8. MCP adapter

Результат: библиотека предоставляет стабильный MCP API поверх application use cases.

- Resources: `abcm://map`, `abcm://map/<scope-id>` и адресуемые разрешённые документы/skill resources.
- Tools: `context.get_domain_language`, `context.build_task_context`, `documentation_source.preview/apply/sync/cutover`.
- Structured schemas, стабильные ABCM error codes, capability/version metadata, pagination/cancellation/timeouts.
- Stdio и Streamable HTTP как отдельные adapters; HTTP adapter включает host/origin validation и auth boundary.
- Contract tests через реальный MCP client для 2025-11-25; отдельный compatibility suite для dual-protocol режима.
- Gate: каждый MCP operation проходит happy-path, schema-rejection, authorization и error-mapping tests.

### M9. REST adapter

Результат: REST parity с MCP без дублирования бизнес-логики.

- Реализовать все `/v1` endpoints спецификации и единый Problem Details/error mapping.
- OpenAPI генерировать из тех же schemas, что использует MCP.
- Parity tests: одинаковый principal/request даёт семантически одинаковый result/error через MCP и REST.
- Gate: contract snapshots, auth tests, request size/rate/timeout limits.

### M10. DocumentationSource sync и cutover

Результат: безопасный one-way mirror и операторский переход в managed mode.

- Non-mutating preview обязателен до apply; include/exclude/mapping и collision rules детерминированы.
- Create/modify/move/delete через atomic writes; delete mirror создаёт tombstone/provenance и новую MapRevision.
- Cutover: final sync, checksum verification, conflict-free plan, атомарная смена storage mode; source не изменяется.
- Gate: SYNC-001..007, AC-DOC-MIRROR-DELETE, AC-DOC-CUTOVER, fault injection между фазами.

### M11. Hardening и релиз 0.1.0

Результат: публично потребляемая библиотека и reference server.

- Threat model: path traversal/symlink escape, malicious YAML/frontmatter, oversized files, resource activation, tenant leakage, DNS rebinding, stale bootstrap/revision races.
- Structured audit events без document bodies/secrets; metrics для scan, resolver, bundle budget, sync conflicts.
- Benchmarks на large fixtures с отдельно измеренными scan/hash/parse/SQLite/resolver/projection costs.
- Package provenance, SBOM, locked dependencies, release notes, API docs и runnable examples.
- Финальный gate: все MUST/MUST_NOT и acceptance scenarios зелёные; известные MAY/SHOULD gaps перечислены; clean install/build/test на Bun и поддерживаемом Node.js.

## 4. Порядок поставки

Вертикальные инкременты:

1. `0.1.0-alpha.1`: M0-M3 — сканирование и атомарная карта.
2. `0.1.0-alpha.2`: M4-M6 — projections, domain language, skills.
3. `0.1.0-alpha.3`: M7-M9 — ContextBundle и публичные MCP/REST contracts.
4. `0.1.0-beta.1`: M10 — documentation sync/cutover.
5. `0.1.0`: M11 и полная acceptance/traceability evidence.

Каждый инкремент начинается с RED acceptance/contract tests, заканчивается обновлением traceability manifest и сохраняет evidence отдельно от generated build output.

### Текущая реализация

- PLAN-0001 поставил первый рабочий FileWorkspace/ScopeMap/REST/MCP vertical slice.
- PLAN-0003 добавил server-owned managed workspaces и безопасный импорт документации.
- PLAN-0004 поставил фундамент M2: versioned SQLite schema, rollback journal, scan leases/fencing, atomic active MapRevision и rebuild после удаления БД.
- PLAN-0005 добавил schema v2, exclusive runtime owner lease, heartbeat, graceful release и crash-expiry recovery.
- M2 остаётся незавершённым до репозиториев file/document/resource/provenance/sync/tombstone/context state и renewal отдельной аренды долгого scan session.
- M3 остаётся незавершённым до полного MAP-P0..P6 indexing/reconcile pipeline и periodic full reconcile.

## 5. Риски и открытые решения до M1

- Уточнить lifecycle draft-спецификации 0.5: какие изменения считаются breaking до 1.0.
- Зафиксировать поддерживаемые ОС/filesystems и способ надёжного определения network filesystem.
- Выбрать SQLite binding для Bun + Node с одинаковыми transaction/locking semantics.
- Зафиксировать auth principal/tenant provider interface и минимальный MVP access profile.
- Определить scoring weights, semantic matcher provider и thresholds как versioned configuration, не скрытые constants.
- Определить token estimator/model profiles; digest не должен зависеть от нестабильного внешнего tokenizer без version pinning.
- Выбрать REST framework и HTTP deployment model после проверки Streamable HTTP adapter SDK.

Эти решения оформляются ADR до кода соответствующего milestone; они не должны расширять product boundary спецификации.
