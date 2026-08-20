import { createHash } from "node:crypto";

import { ABCM_RUNTIME_VERSION } from "../core/server-info.js";

export const ABCM_AGENT_INSTRUCTIONS_VERSION = ABCM_RUNTIME_VERSION;
export const ABCM_AGENT_INSTRUCTIONS_CONTENT_TYPE = "text/markdown; charset=utf-8" as const;

/** Каноническая самодостаточная инструкция, возвращаемая всеми адаптерами ABCM. */
export const ABCM_AGENT_INSTRUCTIONS = `# Инструкция для агента ABCM

Версия: ${ABCM_AGENT_INSTRUCTIONS_VERSION}

ABCM (Agent Build Context Manager) предоставляет агентам ограниченное и воспроизводимое представление проекта. Файлы рабочего пространства являются источником истины. Ревизии ScopeMap, контекстные пакеты, индексы и состояние SQLite — производные представления; их запрещено редактировать как первичные данные.

## Протокол первого подключения

Агент, подключённый к ABCM, ОБЯЗАН (MUST):

1. Прочитать эту инструкцию при первом подключении и повторно читать её при изменении версии.
2. Прочитать обязательное поле language в <project>/config/context.yaml и использовать этот язык для общения и новых человекочитаемых документов.
3. Явно определить целевое рабочее пространство и проект. Запрещено угадывать их идентификаторы.
4. Вызвать scope_map.scan, если актуальная ревизия карты отсутствует.
5. Прочитать effective file architecture через workspace.get_architecture_policy и проверить её через workspace.check_architecture_compliance. При required и noncompliant запрещено строить контекст в обход ошибки.
6. До толкования терминов проекта или определения пути задачи вызвать context.get_domain_language с якорем workspaceId и projectId.
7. Если scope, причины выбора или ожидаемый размер спорны, сначала вызвать context.preview_task_context: preview не записывает fingerprint и не возвращает тела документов.
8. Вызвать context.build_task_context либо, когда отбор требуется уточнять по связям документов, пройти context.start_link_graph_session → step/confirm → context.finalize_link_graph_session. Финализация графа обязана использовать тот же ContextBuilder.
9. Работать только с ограниченным контекстным пакетом и файлами, которые намеренно прочитаны для задачи. По умолчанию запрещено сканировать всё рабочее пространство.
10. Сохранить в итоговом отчёте контрольные суммы, ревизии карты, доказательства и результаты проверок.

Если обязательная операция недоступна, остановитесь и сообщите об отсутствующей возможности. Запрещено подменять разрешение контекста ABCM неограниченным сканированием файловой системы.

## Модель фреймворка

- Рабочее пространство (Workspace): зарегистрированная граница хранения с идентификатором workspaceId. Пути API задаются относительно этой границы.
- Проект (Project): корневой контур проекта внутри рабочего пространства. Одно рабочее пространство может содержать несколько проектов.
- Политика файловой архитектуры (Architecture policy): управляемая конфигурация config/architecture.yaml. Workspace-policy действует по умолчанию на проекты workspace, а project-policy с тем же projectId является независимым override. Базовый профиль — required + abcm-mvp-agent-spec-v0.5.
- Язык проекта (Project language): обязательный BCP 47-тег в config/context.yaml, который определяет язык общения агента и новых человекочитаемых документов. Он не заменяет язык предметной области.
- Контур (Scope): workflow, project, service или feature, объявленный файлом scope.yaml. Отношения родитель–потомок образуют топологию проекта.
- Язык предметной области (Domain language): наследуемые соглашения, домены, понятия, псевдонимы, омонимы и правила именования в каталоге domain-language. Он определяет толкование терминов задачи.
- ScopeMap: неизменяемая ревизия, производная от контуров, связей, документов, исполняемых ресурсов, навыков, типизированного графа ссылок и диагностик.
- Типизированный граф ссылок (Typed link graph): body-free индекс wiki links, embeds, ссылок на заголовки и блоки, frontmatter-связей и backlinks. Узлы закреплены за documentId; неоднозначные, битые и циклические связи диагностируются детерминированно.
- PlantUML source: инертный типизированный исполняемый ресурс из architecture/plantuml/<category>/*.puml. ABCM проверяет envelope и безопасные локальные include, фиксирует dependency closure, но не исполняет и не рендерит диаграмму.
- Контекстный пакет (Context bundle): неизменяемая ограниченная бюджетом выборка для одной задачи, роли, цели и ревизии карты.
- Cache контекста: производное versioned-представление, ключ которого включает principal/access digest, MapRevision, проект, запрос, budget и версии selection/projection policy. Состояние hit, miss или stale является наблюдаемым и не меняет bundleDigest.
- Business-eval profile: версионированный операторский профиль на сервере, который связывает workspace, запросы, fixtures, gold-набор, V0–V5 и пороги. Агент может выбрать только зарегистрированный profileId и не может передать серверу manifest, абсолютный путь или исполняемый код.
- Business-eval run: серверное исполнение зарегистрированного профиля для вариантов V0–V5. Оно сохраняет неизменяемый receipt без тел документов, но само по себе не доказывает качество продукта без пройденных relevance, fallback, determinism, isolation и task-success gates.
- Task-success worker: отдельный процесс, который получает слепое задание и уже собранный ABCM контекст, вызывает закреплённую языковую модель и возвращает только контрольные суммы, вердикт и числовые показатели. Ключ модели, полный ответ и номер варианта не хранятся в ABCM receipt; после перезапуска восстанавливаются только безтекстовые завершённые результаты, а контекст формируется заново из закреплённого снимка.
- Навык (Skill): повторно используемая процедура с объявленными требованиями к контексту. Навык дополняет рабочий процесс, но не может отменять инструкции рабочего пространства или границы доступа.
- План (Plan): контракт разработки с трассировкой требований. Планы фич, планы проверки, доказательства и записи трассировки хранятся вместе с ним.
- Источник документации (Documentation source): внешний каталог, например хранилище Obsidian, который можно предварительно сравнить, синхронизировать и явно перевести под управление ABCM.

## Рекомендуемая структура проекта

    <project>/
      scope.yaml
      config/
        context.yaml
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

Спецификация рабочего пространства может уточнять управляемые каталоги, однако граница каждого контура должна быть явной, а у каждого нормативного документа должен быть ровно один канонический владелец.

## Минимальная настройка

Каждый проект ОБЯЗАН (MUST) объявить язык в config/context.yaml:

    apiVersion: abcm/v1
    kind: ContextConfig
    language: ru

Значение language — непустой BCP 47-тег, например ru, ru-RU или en. Отсутствующее, пустое или невалидное поле делает конфигурацию проекта неготовой для работы агента.

Новый управляемый workspace также получает базовую политику файловой архитектуры:

    apiVersion: abcm/v1
    kind: ArchitecturePolicy
    enforcement: required
    architecture: abcm-mvp-agent-spec-v0.5

Управляйте политикой через специализированные операции, а не через незащищённую замену произвольного YAML. Если projectId не передан, настройка применяется на уровне workspace. Если projectId передан, создаётся или заменяется независимый project override. Одно workspace может содержать несколько project policies.

MCP-примеры:

    workspace.set_architecture_policy({
      workspaceId: "castalia-public",
      ifNoneMatch: "*"
    })

    workspace.set_architecture_policy({
      workspaceId: "castalia-public",
      projectId: "abcm",
      enforcement: "required",
      architecture: "abcm-mvp-agent-spec-v0.5",
      ifNoneMatch: "*"
    })

    workspace.check_architecture_compliance({
      workspaceId: "castalia-public",
      projectId: "abcm"
    })

REST использует PUT/GET/DELETE /v1/workspaces/{workspaceId}/architecture-policy для workspace и /v1/workspaces/{workspaceId}/projects/{projectId}/architecture-policy для проекта. Перед заменой используйте If-Match с checksum текущей записи; при создании — If-None-Match: *. GET project policy возвращает configured и effective: при отсутствии project override effective наследуется от workspace. Список всех независимых записей возвращает GET /v1/workspaces/{workspaceId}/architecture-policies.

required означает соблюдение нормативных MUST/MUST_NOT выбранного профиля: hierarchy, scope.yaml, DomainLanguageConvention и размещение нормативных материалов. Иллюстративные пустые каталоги из completeExample не становятся обязательными сами по себе.

Контрпримеры: изменить workspace-policy, когда требовалось исключение только для одного проекта; считать configured=null отсутствием политики, не проверив effective; повторно записать настройку без If-Match; продолжить context build после ARCHITECTURE_POLICY_VIOLATION.

Пример MCP, если сервер настроен с управляемым хранилищем рабочих пространств:

    workspace.create({
      id: "castalia-public",
      name: "Castalia Public",
      language: "ru"
    })

Пример REST:

    POST /v1/workspaces
    Content-Type: application/json

    {"id":"castalia-public","name":"Castalia Public","language":"ru"}

    POST /v1/workspaces/castalia-public/directories
    Content-Type: application/json

    {"path":"sample-project"}

    PUT /v1/workspaces/castalia-public/files/content?path=sample-project%2Fscope.yaml
    If-None-Match: *

    apiVersion: abcm/v1
    kind: project
    id: sample-project
    name: Пример проекта

Затем создайте domain-language/DomainLanguageConvention.md и обязательные документы плана, роли и навыков. До выполнения задач просканируйте ScopeMap и разрешите язык предметной области.

Создание самого рабочего пространства через MCP выполняется только операцией workspace.create. Она принимает id, необязательное name и обязательный BCP 47 language, но не принимает host path: каталог выбирает сервер. После регистрации создавайте проект внутри workspace операциями workspace.create_directory и workspace.write_file; передавайте workspaceId, относительный путь, содержимое UTF-8 и ifNoneMatch со значением * для записи только при отсутствии файла. Если workspace.create отсутствует в списке tools, provisioning отключён оператором и агент обязан запросить регистрацию через настроенный административный REST workflow.

## Правильные и неправильные инструкции контура

Правильный контур:

    apiVersion: abcm/v1
    kind: feature
    id: billing-retry
    name: Повтор платежа
    parentScopeId: payments-service

Правильная инструкция:

    Перед изменением поведения повторных платежей загрузите язык домена payments,
    разрешите контур billing-retry, выполните его план проверки и приложите доказательства.

Это правильно: явно указаны идентичность, вид, владелец, родитель, порядок действий и доказательства.

Контрпример:

    name: Что-то в бэкенде

    Прочитайте всё, внесите необходимые изменения и обновите всё, что покажется относящимся к задаче.

Это неправильно: контур неоднозначен, контекст не ограничен, владелец неизвестен, а результат невозможно воспроизвести.

## Язык общения и документов

- Поле language определяет язык ответов агента, планов, инструкций и новых человекочитаемых документов.
- Идентификаторы, код, пути, имена API, точные канонические термины и цитируемые фрагменты не переводятся автоматически.
- Явная просьба пользователя подготовить отдельный артефакт на другом языке действует только для этого артефакта и не меняет конфигурацию проекта.
- Изменение основного языка проекта выполняется отдельной записью config/context.yaml с ifMatch и последующей проверкой ScopeMap.
- Поле language и каталог domain-language решают разные задачи: первое задаёт язык представления, второй задаёт значение и допустимое употребление терминов.

Правильно:

    apiVersion: abcm/v1
    kind: ContextConfig
    language: ru-RU

После чтения такой конфигурации агент отвечает по-русски, но сохраняет без перевода идентификаторы workspaceId, ScopeMap и context.build_task_context.

Контрпримеры:

    apiVersion: abcm/v1
    kind: ContextConfig

Здесь обязательное поле language отсутствует.

    language: русский

Здесь использовано название языка вместо BCP 47-тега.

## Правила языка предметной области

- Используйте объявленные термины проекта. Не придумывайте синонимы при наличии канонического термина.
- Разрешайте псевдонимы и омонимы через context.get_domain_language; догадка по имени файла не является разрешением языка.
- Предупреждение DOMAIN_ALIAS_DEPRECATED означает, что псевдоним ещё разрешён в канонический термин, но новые запросы и документы СЛЕДУЕТ (SHOULD) перевести на canonicalTerm из resolver trace. Не игнорируйте warning и не считайте его блокирующей ошибкой.
- Размещайте глобальные соглашения на границе проекта, а более узкие дополнения — в дочерних контурах. Уточняйте наследуемый язык только тогда, когда это разрешено спецификацией.
- Считайте конфликт, невалидный контур, неразрешённую обязательную связь или неготовый bootstrap блокирующей ошибкой. Запрещено выбирать удобное толкование.

Правильно: после bootstrap последовательно использовать объявленный термин ScopeMap.

Контрпример: использовать термины «карта проекта», «дерево контекста», «граф репозитория» и ScopeMap как взаимозаменяемые.

## Контекст задачи для нескольких контуров

Когда одна задача явно затрагивает несколько известных scopes, передавайте их отдельным ordered-массивом targetHints.scopeIds. Первый exact scope является primary и ОБЯЗАН находиться внутри anchor-project использованного DomainLanguageBootstrap. Остальные exact scopes могут находиться в других проектах того же workspace; все они разрешаются в одной pinned MapRevision.

MCP-пример:

    context.build_task_context({
      domainLanguageBootstrapId: "bootstrap-...",
      roleId: "executor-agent",
      taskType: "cross-service-migration",
      goal: "Перенести контракт заказов из catalog в billing",
      targetHints: {
        scopeIds: ["catalog", "billing"],
        componentNames: ["orders"]
      },
      budgetProfile: "expanded"
    })

REST использует то же тело в POST /v1/context/build-task-context. Можно передать canonical id или URI abcm://scope/<id>. От одного до восьми exact scopes должны быть уникальны после canonicalization. Legacy array targetHints и componentNames остаются fuzzy hints и не объявляют дополнительные scopes.

Для проверки выбора до materialization передайте то же тело в context.preview_task_context или POST /v1/context/preview-task-context. Ответ содержит selectionPolicyVersion, причины, effectivePriority, выбранную проекцию, tokenEstimate, omissions, fallbackModes и cache state, но не содержит тела документов и не создаёт ContextFingerprint.

Правильно: при неожиданном scope или шумном списке сначала изучить preview, затем уточнить exact scope, taskType, keywords или explicit document links и только после этого построить bundle.

Fallback при недостаточном автоматическом контексте выполняется явно и ограниченно: direct-search внутри разрешённых path prefixes, explicit documents через типизированный abcm:// URI либо bounded resource/file read. Первичный промах resolver должен оставаться видимым в отчёте; запрещено выдавать восстановленный результат за успешный автоматический выбор.

Для точного выбора документов используйте explicitDocuments. Поддерживаются selector \`document-id\`, \`uri\`, \`repository-file\`, \`repository-directory\` и \`repository-prefix\`; для проверки типа можно добавить expectedKind. Directory selector по умолчанию не рекурсивен, recursive=true должен быть явным. Все варианты разрешаются по одному active MapRevision index и становятся mandatory context.

Пример:

    explicitDocuments: [
      { selector: "document-id", documentId: "ADR-SEARCH", expectedKind: "adr" },
      { selector: "repository-directory", path: "project/search/artifacts/contracts", recursive: true }
    ]

Ошибки различаются: malformed input — REQUEST_INVALID на границе схемы; отсутствующий selector — CONTEXT_DOCUMENT_NOT_FOUND; недоступный — CONTEXT_DOCUMENT_ACCESS_DENIED без раскрытия тела; несовпавший expectedKind — CONTEXT_DOCUMENT_KIND_MISMATCH; изменение после MapRevision — DOMAIN_LANGUAGE_BOOTSTRAP_STALE; обязательный контекст вне hard limit — REQUIRED_CONTEXT_EXCEEDS_LIMIT.

Для MCP предметная ошибка всегда имеет isError=true. Совместимое текстовое содержимое содержит JSON с полем code, а structuredContent содержит тот же стабильный код в error_code и сообщение в message. Объявленная outputSchema каждого tool является объединением успешного результата и общей схемы предметной ошибки, поэтому строгий клиент обязан сохранить error_code. Не классифицируйте предметную ошибку по тексту и не заменяйте UNKNOWN_DOMAIN_TERM, CONTEXT_DOCUMENT_NOT_FOUND или REQUIRED_CONTEXT_EXCEEDS_LIMIT общим INVALID_ARGUMENT.

canonicalTerms принимает canonical concept id, основной term, alias или однозначный homonym. Например, если glossary объявляет id=abcm.scope-map и term=ScopeMap, оба значения допустимы и нормализуются к abcm.scope-map; неизвестный term обязан завершиться UNKNOWN_DOMAIN_TERM.

Контрпримеры: передавать \`../secret.md\`; использовать fuzzy repositoryPaths вместо explicitDocuments и ожидать mandatory semantics; скрывать CONTEXT_DOCUMENT_NOT_FOUND неограниченным сканированием workspace.

Контрпример: скрыто просканировать весь workspace после неполного preview, смешать найденные файлы с bundle и заявить, что resolver выбрал их автоматически.

## Интерактивный граф ссылок

Интерактивный граф применяется только для уточнения кандидатов после обычного Context preview. Он не является вторым ContextBuilder и не даёт произвольного чтения workspace. ScopeMap извлекает из Markdown только метаданные узла, aliases, заголовки, block ids и объявления связей; тела документов в графе и состоянии сессии не хранятся.

Поддерживаемые типы рёбер: wiki-link, embed, heading-reference, block-reference, domain-relation и производный backlink. Разрешение выполняется по documentId, title, alias и безопасному относительному пути. Один и тот же MapRevision и запрос дают одинаковые node/edge ids, порядок кандидатов и graph digest. LINK_GRAPH_BROKEN, LINK_GRAPH_AMBIGUOUS и LINK_GRAPH_CYCLE являются наблюдаемыми диагностическими кодами.

Сессия привязана к workspaceId, principal/access digest, MapRevision, linkGraph policy и selection policy. До помещения кандидата во frontier сервер проверяет document.read; запрещённый документ не появляется ни как кандидат, ни как скрытый omission с раскрывающим идентификатором. Каждая операция передаёт следующий sequence и previousStateDigest. Точный повтор той же операции идемпотентен; повтор sequence с другим содержимым, пропуск номера или устаревший digest завершается CONTEXT_GRAPH_SEQUENCE_CONFLICT. Изменение ScopeMap завершает сессию CONTEXT_GRAPH_SESSION_STALE.

MCP-пример:

    context.start_link_graph_session({
      workspaceId: "castalia-public",
      request: {
        domainLanguageBootstrapId: "bootstrap-...",
        roleId: "executor-agent",
        taskType: "implementation",
        goal: "Изменить обработку команд",
        targetHints: { scopeIds: ["dataplane-command-gateway"] }
      },
      seedDocumentIds: ["ADR-COMMANDS"]
    })

    context.step_link_graph_session({
      sessionId: "graph-session-...",
      sequence: 1,
      previousStateDigest: "sha256:...",
      operation: { kind: "confirm", documentIds: ["RUNBOOK-COMMANDS"] }
    })

    context.finalize_link_graph_session({
      sessionId: "graph-session-...",
      expectedStateDigest: "sha256:..."
    })

expand добавляет доступных соседей выбранных узлов; narrow оставляет явный поднабор видимых кандидатов; confirm делает документы обязательными explicit document selectors при финализации; undo откатывает последнюю операцию; cancel закрывает сессию. Финальный ответ содержит bundle и body-free receipt с закреплёнными ревизиями, digest каждого шага, изменением прогноза токенов и digest результата. Сам bundle, budget admission, projections, cache и ContextFingerprint строит существующий ContextBuilder. Если граф не помогает, используйте объявленные fallback modes: direct-search в разрешённой границе, explicit-documents или bounded-resource-read.

REST использует POST /v1/context/link-graph/sessions, GET состояния, POST /steps, POST /ticket и POST /finalize. WebSocket /v1/context/link-graph/ws переносит только sequenced step-сообщения и body-free состояния. Bearer-токен запрещено помещать в URL. Для подключения используются возвращённые сервером subprotocols: версия протокола, session id и короткоживущий одноразовый ticket. Для reconnect получите новый ticket через context.issue_link_graph_ticket или REST /ticket, передав текущий state digest.

Правильно: изучить body-free кандидатов, подтвердить только необходимые документы и финализировать штатным вызовом. Контрпримеры: передать чужой documentId как seed; повторить использованный ticket; отправить sequence=3 после sequence=1; продолжить после изменения MapRevision; считать candidate уже прочитанным телом документа; обходить CONTEXT_GRAPH_SESSION_STALE прямым неограниченным сканированием.

Проверяйте ответ:

- primaryTargetScope — первый подтверждённый exact scope;
- affectedScopes — primary, остальные explicit scopes и ограниченный outgoing relation closure в стабильном порядке;
- affectedScopeDetails — disclosure-safe причина, depth и relation evidence каждого включённого scope;
- multiScopePolicyDigest — версия точных bounds и relation allowlist;
- budgetAllocation — requested, reserved mandatory, consumed/selected и omitted optional tokens по scope buckets; для каждого bucket consumed не может быть меньше reserved;
- bundleDigest и ContextFingerprint — воспроизводимая идентичность всего результата.
- cache — hit, miss или stale, точный key digest, snapshot/access digests и версии cache/projection policy; stale означает, что старое совпадение не было использовано и результат построен заново. Cache хранит только body-free метаданные документов и навыков; при hit тела повторно читаются из закреплённой ревизии и сверяются по checksum.

Недоступный explicit scope останавливает весь build с generic TARGET_SCOPE_INVALID: нельзя продолжать с частичным bundle. Недоступный relation-derived scope исключается до формирования details, warnings, omissions и allocation; его id запрещено раскрывать. Mandatory context и подключённые skills всех разрешённых scopes резервируются до optional round-robin.

Правильно: передать ["catalog", "billing"], если catalog — primary внутри anchor-project, а billing действительно участвует в одной миграции.

Контрпримеры:

- передать ["billing", "catalog"] лишь потому, что лексикографическая сортировка кажется удобнее, и тем самым незаметно изменить primary;
- добавить предположительный или недоступный scope «на всякий случай»;
- поместить scope ids в componentNames и ожидать exact multi-scope semantics;
- считать affectedScopes разрешением на запись или distributed transaction;
- продолжить работу после TARGET_SCOPE_INVALID с самостоятельно уменьшенным списком;
- упомянуть hidden relation target в отчёте, omission или диагностике.

В версии multi-scope-v1 Primary EffectiveDomainLanguage нормализует intent для всей задачи. Secondary scopes добавляют применимые документы, skills и ancestor policy, но не переопределяют смысл goal.

## Протокол выполнения задачи

1. Повторно сформулируйте цель и явно укажите целевой контур.
2. Получите актуальный bootstrap языка предметной области.
3. Постройте контекстный пакет для выбранной роли и типа задачи.
4. Проверьте предупреждения, конфликты, пропуски, подключённые навыки, выбранные документы и бюджет.
5. Читайте дополнительные файлы только тогда, когда это обосновано задачей или ссылкой из выбранного документа.
6. Перед записью прочитайте текущий файл и сохраните его контрольную сумму.
7. Для замены используйте ifMatch, для создания — ifNoneMatch=*.
8. Для двух и более связанных изменений либо когда частичный результат недопустим используйте отдельные upload-сессии и workspace.batch_apply.
9. Для каждого нового содержимого объявите размер и SHA-256 всего файла через workspace.upload_start, передайте последовательные chunks с SHA-256 декодированных байтов и завершите upload через workspace.upload_complete.
10. До применения пакета получите активную ревизию ScopeMap. Сначала можно выполнить dryRun=true, затем применить тот же набор с dryRun=false и устойчивым idempotencyKey.
11. Проверьте status, replayed, каждый элемент results, warnings, mapRevisionBefore и mapRevisionAfter. Ошибка валидации или commit откатывает весь пакет.
12. Для одиночной мутации выполните повторное сканирование либо дождитесь фонового reconcile. Успешный batch_apply выполняет один reconcile сам; ревизия может остаться прежней, если изменённый файл не влияет на входы ScopeMap.
13. Выполните план проверки фичи и сохраните доказательства. Запрещено заявлять о проверках, которые не выполнялись.
14. Если сервер предоставляет outcome API, после фактической проверки зарегистрируйте отдельный context.record_outcome для каждого repeat. Укажите fingerprintId, тот же runId, rubric/model/evidence digests, usage и стоимость; не помещайте в receipt тела документов или полный output задачи.
15. Если выбранный документ оказался полезным, шумным или обязательным, можно создать context.propose_feedback. Указывайте только documentId из собственного ContextFingerprint и rationaleDigest. Ответ всегда имеет status=proposed: он не меняет active ranking или dataset без regression gates и отдельного решения оператора.
16. Если сервер предоставляет business-eval API, сначала вызовите context.list_business_evaluation_profiles, затем передайте в context.run_business_evaluation только profileId. Dataset, fixtures, gold, workspace snapshot, access, request set, baseline, selection/cache/projection policies, budget и measurement window закрепляет сервер. V0 является baseline; V3 обязан фиксировать cold cache, V4 — warm cache. Проверяйте variantAggregates: V1/V2 являются диагностическими сравнениями, а эффективность V3–V5 вычисляется только после correctness, quality и fallback gates. Получайте историю через context.list_business_evaluations.
17. Для task-success профиля вызовите context.start_task_success_evaluation и проверяйте состояние через context.get_task_success_evaluation. Внешний worker использует отдельный ключ и REST claim/submit; агенту запрещено запрашивать или передавать этот ключ. Worker не должен видеть variant или gold и не может отправлять в ABCM полный model output. Повторный запуск той же закреплённой identity идемпотентен.

Правильный запуск retrieval-оценки:

    context.run_business_evaluation({ profileId: "docker-known-data-server-owned-v1" })

Контрпример: передать dataset, fixtures, абсолютный путь к corpus или команду запуска. Общая схема обязана отклонить такой запрос; сервер исполняет только заранее зарегистрированные профили.

Правильная замена через MCP:

    workspace.write_file({
      workspaceId: "castalia-public",
      path: "sample-project/plans/PLAN-0001/plan.md",
      content: "...",
      encoding: "utf8",
      ifMatch: "sha256:<current-checksum>"
    })

Контрпример: при замене существующего файла не передавать ifMatch. Это отключает защиту от конкурентной записи и может затереть изменения человека или другого агента.

## Отдельная upload-передача и атомарный batch_apply

Upload-сессия хранится вне канонического рабочего пространства и сама по себе не создаёт файл проекта. Она привязана к workspaceId, объявленному размеру и SHA-256 всего содержимого. Chunks передаются строго по порядку, начиная с index=0. Точный повтор уже принятого chunk с тем же размером и checksum безопасен; другой байтовый состав для занятого index является конфликтом. Завершённый upload неизменяем, имеет срок жизни и может использоваться только в том же workspace.

В MCP содержимое chunk передаётся строкой base64. В REST содержимое передаётся реальными байтами application/octet-stream, а checksum декодированных байтов — в X-Content-Sha256. Во всех checksum используется форма sha256:<64 lowercase hex>.

Пример MCP для файла с заранее вычисленными размером и контрольными суммами (значения в угловых скобках нужно заменить реальными):

    workspace.upload_start({
      workspaceId: "castalia-public",
      size: 12,
      checksum: "sha256:<full-file-checksum>",
      contentType: "text/markdown; charset=utf-8"
    })

    workspace.upload_chunk({
      workspaceId: "castalia-public",
      uploadId: "upl_<id-from-start>",
      index: 0,
      content: "IyDQotC10YHRgg==",
      encoding: "base64",
      checksum: "sha256:<checksum-of-decoded-chunk>"
    })

    workspace.upload_complete({
      workspaceId: "castalia-public",
      uploadId: "upl_<id-from-start>"
    })

После подготовки всех uploadId примените один смешанный пакет:

    workspace.batch_apply({
      workspaceId: "castalia-public",
      idempotencyKey: "agent-task-42-apply-1",
      expectedMapRevision: "sha256:<active-map-revision>",
      dryRun: false,
      operations: [
        {
          operation: "create",
          path: "sample-project/docs/new.md",
          uploadId: "upl_<completed-upload-id>",
          ifNoneMatch: "*"
        },
        {
          operation: "update",
          path: "sample-project/docs/current.md",
          uploadId: "upl_<another-completed-upload-id>",
          ifMatch: "sha256:<current-file-checksum>"
        },
        {
          operation: "move",
          from: "sample-project/docs/old-name.md",
          to: "sample-project/docs/new-name.md",
          ifMatch: "sha256:<source-file-checksum>",
          overwrite: false
        },
        {
          operation: "delete",
          path: "sample-project/docs/obsolete.md",
          ifMatch: "sha256:<current-file-checksum>"
        }
      ]
    })

Операции create и update содержат uploadId, но не содержат inline content. Delete не содержит содержимого вообще. Move переносит уже существующие байты и также не требует uploadId. В пакете допускается от 1 до 100 операций; один путь нельзя затронуть дважды, включая from и to. Все пути, uploadId, checksum, права, expectedMapRevision и лимиты проверяются до commit. При любой ошибке ни одна операция не должна остаться применённой. После успеха тот же запрос с тем же idempotencyKey возвращает сохранённый receipt с replayed=true; тот же ключ с другим запросом запрещён.

REST-последовательность эквивалентна:

    POST /v1/workspaces/{workspaceId}/uploads
    PUT /v1/workspaces/{workspaceId}/uploads/{uploadId}/chunks/0
    POST /v1/workspaces/{workspaceId}/uploads/{uploadId}/complete
    POST /v1/workspaces/{workspaceId}/files/batch:apply

Для PUT тело содержит raw bytes, Content-Type: application/octet-stream и обязательный X-Content-Sha256. Неиспользуемую upload-сессию удаляйте через workspace.upload_abort либо DELETE /v1/workspaces/{workspaceId}/uploads/{uploadId}.

Контрпримеры: передать content прямо в batch_apply; сослаться на незавершённый upload; повторно использовать idempotencyKey с другим набором операций; затронуть один путь двумя операциями; применить пакет с устаревшим expectedMapRevision; считать новую MapRevision обязательной для изменения обычного неиндексируемого файла.

## Планы, фичи и доказательства

План разработки СЛЕДУЕТ (SHOULD) составлять из цели, области работ, исключений, предположений, зависимостей, рисков, идентификаторов требований, срезов фич, последовательности test-first, критериев приёмки, негативных сценариев, покрытия проверками, трассировки, доказательств и плана отката или восстановления для изменений состояния.

Правильно: помечать фичу завершённой только тогда, когда каждому критерию приёмки соответствует доказательство.

Контрпример: считать план завершённым только потому, что код компилируется, хотя интеграционные проверки, документация или доказательства миграции ещё не готовы.

## Безопасность файлов и хранения

- Используйте только относительные пути рабочего пространства. Абсолютные пути, переходы к родительским каталогам, зарезервированные пути и выход через символические ссылки запрещены.
- Перед перемещением, удалением или заменой выполните перечисление и чтение.
- Для разрушающих операций и замены используйте предусловия с контрольной суммой.
- Запрещено через файловые операции проекта изменять .git, секреты, производные базы данных, ревизии ScopeMap, сгенерированные экспорты и зарезервированное состояние среды выполнения.
- FILE_CHECKSUM_MISMATCH означает: перечитать файл и согласовать изменения. Запрещено повторять операцию без предусловия.
- Сохраняйте несвязанные изменения пользователя.

Правильное перемещение: прочитать исходный файл, сохранить его контрольную сумму, переместить без перезаписи, затем проверить исходный и целевой пути.

Контрпример: установить overwrite=true до проверки файла назначения.

## Перемещение и удаление каталогов

Каталоги изменяются только отдельными операциями directory: они не являются файлами и не принимают file checksum. Перед операцией рекурсивно перечислите каталог, проверьте каждый файл и убедитесь, что в нём нет зарезервированных путей или символических ссылок. Перемещение не перезаписывает существующий target и не допускает перенос каталога в самого себя или своего потомка. Удаление всегда рекурсивно и требует явного подтверждения recursive=true.

Правильный MCP-вызов перемещения:

    workspace.move_directory({
      workspaceId: "castalia-public",
      from: "sample-project/docs/drafts",
      to: "sample-project/docs/archive/drafts"
    })

Правильный MCP-вызов удаления:

    workspace.delete_directory({
      workspaceId: "castalia-public",
      path: "sample-project/docs/archive/drafts",
      recursive: true
    })

REST-эквиваленты:

    POST /v1/workspaces/{workspaceId}/directories/move
    Content-Type: application/json

    {"from":"sample-project/docs/drafts","to":"sample-project/docs/archive/drafts"}

    DELETE /v1/workspaces/{workspaceId}/directories?path=sample-project%2Fdocs%2Farchive%2Fdrafts&recursive=true

После успеха повторно перечислите target или родительский каталог. Каждый перемещённый или удалённый файл публикуется как отдельное изменение для ScopeMap и клиентов синхронизации.

Контрпримеры: вызвать workspace.move_file для каталога; удалить каталог без recursive=true; переместить каталог в его дочерний путь; ожидать неявного overwrite существующего target; пытаться обойти запрет через каталог, содержащий .git, node_modules, .env или символическую ссылку.

## Карта операций REST

- GET /v1/agent-instructions: эта инструкция.
- POST /v1/workspaces: объявление управляемого хранилища, если включено создание рабочих пространств.
- Маршруты files/content и files/move: безопасный жизненный цикл одиночных файлов.
- Маршруты directories и directories/move: создание, рекурсивное удаление и перемещение каталогов.
- Маршруты uploads: отдельная передача и проверка байтов до файловой мутации.
- POST /v1/workspaces/{workspaceId}/files/batch:apply: атомарный смешанный пакет create/update/delete/move.
- Маршруты сканирования и чтения scope-map рабочего пространства: перестроение и чтение ограниченной топологии.
- POST /v1/context/domain-language: bootstrap языка предметной области.
- POST /v1/context/preview-task-context: объяснимый body-free preview без записи fingerprint.
- POST /v1/context/build-task-context: неизменяемый контекст задачи.
- Маршруты /v1/context/link-graph/sessions: body-free интерактивный отбор, sequenced steps, новый одноразовый WebSocket ticket и финализация через ContextBuilder.
- WebSocket /v1/context/link-graph/ws: только step-транспорт; bearer не передаётся в URL, авторизация соединения выполняется одноразовыми subprotocol tickets.
- POST и GET /v1/context/outcomes: регистрация и чтение неизменяемых body-free outcome receipts, связанных с ContextFingerprint.
- POST и GET /v1/context/feedback: создание и чтение body-free proposal для ranking-policy или dataset; active policy не изменяется.
- Маршруты preview, apply, sync и cutover документации: управляемый жизненный цикл внешних документов.
- GET /openapi.json: точный машиночитаемый контракт.

Если включена авторизация, используйте Authorization: Bearer <token>. Токены являются секретами: никогда не помещайте реальные значения в документацию, URL, журналы или примеры, сохраняемые в репозитории.

## Карта операций MCP

- agent_instructions.get: эта инструкция; вызывайте первой.
- workspace.create: создание server-owned рабочего пространства с обязательным языком, если provisioning включён оператором.
- workspace.list_files, read_file, write_file, delete_file, move_file: безопасный жизненный цикл одиночных файлов.
- workspace.create_directory, move_directory, delete_directory: жизненный цикл каталогов; delete_directory требует recursive=true.
- workspace.upload_start, upload_chunk, upload_complete, upload_abort: отдельная checksum-bound передача байтов.
- workspace.batch_apply: атомарная смешанная мутация до 100 операций с dry-run, MapRevision и idempotency receipt.
- scope_map.scan: получение актуальной ревизии ScopeMap.
- context.get_domain_language: обязательный bootstrap языка до толкования пути задачи.
- context.preview_task_context: объяснимый выбор документов, проекций, бюджета и fallback без materialized bodies и производной записи.
- context.build_task_context: ограниченный контекстный пакет задачи.
- context.start_link_graph_session, get_link_graph_session, step_link_graph_session: body-free интерактивный frontier с pinned revision, sequence и state digest.
- context.issue_link_graph_ticket: новый короткоживущий одноразовый ticket для WebSocket reconnect; предыдущий ticket становится недействительным.
- context.finalize_link_graph_session: финализация подтверждённых документов только через стандартный ContextBuilder.
- context.record_outcome, context.list_outcomes: неизменяемые repeat verdict, usage и cost для собственного ContextFingerprint; повтор repeatId с другим verdict является конфликтом.
- context.propose_feedback, context.list_feedback: immutable proposal для useful/noise/required документа из собственного ContextFingerprint; операция не активирует новую ranking policy.
- context.list_business_evaluation_profiles, context.run_business_evaluation, context.list_business_evaluations: server-owned retrieval benchmark без передачи dataset или corpus агентом.
- context.start_task_success_evaluation, context.get_task_success_evaluation: запуск и чтение body-free task-success с отдельным внешним worker.
- documentation_source.preview, apply, sync, cutover: импорт документации и передача владения, если эти операции настроены.
- Ресурсы MCP предоставляют ограниченную карту и содержимое проекта; сначала обнаруживайте ресурсы, а не угадывайте URI.

## Obsidian и сетевые папки

Для прямой работы откройте каталог зарегистрированного проекта как хранилище Obsidian либо разместите хранилище внутри него. Такие изменения являются изменениями рабочего пространства и обязаны соответствовать структуре и проверкам ABCM.

Для внешнего хранилища настройте источник документации. Сначала выполните preview, изучите операции create/update/move/delete/conflict, затем примените зафиксированный preview. Выполняйте cutover только после явного одобрения оператора и с ожидаемым snapshot digest. После cutover хранилище ABCM становится каноническим, а прежний источник не должен оставаться независимым писателем.

Каталог внешнего источника выбирает оператор при запуске сервера. Агент передаёт только зарегистрированные workspaceId и sourceId и не может задать абсолютный путь через REST или MCP. Выбранный каталог обязан быть отдельным: он не может совпадать с canonical workspace, находиться внутри него или содержать его; граница повторно проверяется после раскрытия симлинков.

Правильно: выбрать отдельный каталог заметок, смонтировать его read-only как documentation source, выполнить preview и только затем apply/sync. Контрпример: выбрать каталог canonical workspace либо его родителя и тем самым организовать импорт источника в самого себя.

Правильно: выполнить preview, разрешить конфликты, применить изменения, проверить ScopeMap и только затем выполнить cutover.

Контрпример: вручную скопировать хранилище в управляемое зеркало и редактировать обе копии. Это создаёт разделённое владение и расхождение данных.

## Политика ошибок и завершения

- Стабильные ошибки ABCM являются данными контракта. Сообщите код, устраните причину и сохраните диагностические подробности.
- Для MCP-ошибки используйте structuredContent.error_code как машиночитаемый код; JSON в текстовой части обязан содержать тот же code. Значения CONTEXT_DOCUMENT_NOT_FOUND, REQUIRED_CONTEXT_EXCEEDS_LIMIT и UNKNOWN_DOMAIN_TERM не должны заменяться общим INVALID_ARGUMENT.
- Ошибка валидации означает неверную форму запроса. Ошибка доступа означает отсутствие разрешения. Ошибка готовности карты означает, что контекст запрещено выдумывать.
- Версия в MCP initialize.serverInfo и версия этой инструкции совпадают. После изменения версии или серверной конфигурации переподключите connector/tunnel, заново получите tools/list и не используйте закэшированный manifest. Полный настроенный контур версии 1.18.1 содержит 42 операции; отсутствие условных business-evaluation, task-success или documentation-source операций означает, что оператор не включил соответствующую конфигурацию.
- Запрещено заявлять об успешном развёртывании, синхронизации, миграции, тестировании или паритете документации без доказательств.
- Итоговый отчёт ОБЯЗАН (MUST) разделять завершённую работу, выполненные проверки, пропущенные проверки, блокеры и невыполненные внешние действия.

Перед завершением подтвердите: рабочее пространство, проект, контур, роль и тип задачи указаны явно; bootstrap и контекстный пакет актуальны; использованы безопасные пути и подходящие предусловия с контрольной суммой; новые блокирующие диагностики карты отсутствуют; критерии сопоставлены с тестами и доказательствами; каноническая документация обновлена без второго источника истины; секреты, зарезервированное состояние и несвязанные изменения пользователя не затронуты.
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
