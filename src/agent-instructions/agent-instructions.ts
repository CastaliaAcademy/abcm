import { createHash } from "node:crypto";

export const ABCM_AGENT_INSTRUCTIONS_VERSION = "1.9.0" as const;
export const ABCM_AGENT_INSTRUCTIONS_CONTENT_TYPE = "text/markdown; charset=utf-8" as const;

/** Каноническая самодостаточная инструкция, возвращаемая всеми адаптерами ABCM. */
export const ABCM_AGENT_INSTRUCTIONS = `# Инструкция для агента ABCM

Версия: 1.9.0

ABCM (Agent Build Context Manager) предоставляет агентам ограниченное и воспроизводимое представление проекта. Файлы рабочего пространства являются источником истины. Ревизии ScopeMap, контекстные пакеты, индексы и состояние SQLite — производные представления; их запрещено редактировать как первичные данные.

## Протокол первого подключения

Агент, подключённый к ABCM, ОБЯЗАН (MUST):

1. Прочитать эту инструкцию при первом подключении и повторно читать её при изменении версии.
2. Прочитать обязательное поле language в <project>/config/context.yaml и использовать этот язык для общения и новых человекочитаемых документов.
3. Явно определить целевое рабочее пространство и проект. Запрещено угадывать их идентификаторы.
4. Вызвать scope_map.scan, если актуальная ревизия карты отсутствует.
5. До толкования терминов проекта или определения пути задачи вызвать context.get_domain_language с якорем workspaceId и projectId.
6. Если scope, причины выбора или ожидаемый размер спорны, сначала вызвать context.preview_task_context: preview не записывает fingerprint и не возвращает тела документов.
7. Вызвать context.build_task_context, передав полученный bootstrap id, явную роль, тип задачи и цель.
8. Работать только с ограниченным контекстным пакетом и файлами, которые намеренно прочитаны для задачи. По умолчанию запрещено сканировать всё рабочее пространство.
9. Сохранить в итоговом отчёте контрольные суммы, ревизии карты, доказательства и результаты проверок.

Если обязательная операция недоступна, остановитесь и сообщите об отсутствующей возможности. Запрещено подменять разрешение контекста ABCM неограниченным сканированием файловой системы.

## Модель фреймворка

- Рабочее пространство (Workspace): зарегистрированная граница хранения с идентификатором workspaceId. Пути API задаются относительно этой границы.
- Проект (Project): корневой контур проекта внутри рабочего пространства. Одно рабочее пространство может содержать несколько проектов.
- Язык проекта (Project language): обязательный BCP 47-тег в config/context.yaml, который определяет язык общения агента и новых человекочитаемых документов. Он не заменяет язык предметной области.
- Контур (Scope): workflow, project, service или feature, объявленный файлом scope.yaml. Отношения родитель–потомок образуют топологию проекта.
- Язык предметной области (Domain language): наследуемые соглашения, домены, понятия, псевдонимы, омонимы и правила именования в каталоге domain-language. Он определяет толкование терминов задачи.
- ScopeMap: неизменяемая ревизия, производная от контуров, связей, документов, исполняемых ресурсов, навыков и диагностик.
- Контекстный пакет (Context bundle): неизменяемая ограниченная бюджетом выборка для одной задачи, роли, цели и ревизии карты.
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

Для проверки выбора до materialization передайте то же тело в context.preview_task_context или POST /v1/context/preview-task-context. Ответ содержит selectionPolicyVersion, причины, effectivePriority, выбранную проекцию, tokenEstimate, omissions и fallbackModes, но не содержит тела документов и не создаёт ContextFingerprint.

Правильно: при неожиданном scope или шумном списке сначала изучить preview, затем уточнить exact scope, taskType, keywords или explicit document links и только после этого построить bundle.

Fallback при недостаточном автоматическом контексте выполняется явно и ограниченно: direct-search внутри разрешённых path prefixes, explicit documents через типизированный abcm:// URI либо bounded resource/file read. Первичный промах resolver должен оставаться видимым в отчёте; запрещено выдавать восстановленный результат за успешный автоматический выбор.

Контрпример: скрыто просканировать весь workspace после неполного preview, смешать найденные файлы с bundle и заявить, что resolver выбрал их автоматически.

Проверяйте ответ:

- primaryTargetScope — первый подтверждённый exact scope;
- affectedScopes — primary, остальные explicit scopes и ограниченный outgoing relation closure в стабильном порядке;
- affectedScopeDetails — disclosure-safe причина, depth и relation evidence каждого включённого scope;
- multiScopePolicyDigest — версия точных bounds и relation allowlist;
- budgetAllocation — фактически выбранные и пропущенные optional tokens по scope buckets;
- bundleDigest и ContextFingerprint — воспроизводимая идентичность всего результата.

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
- POST и GET /v1/context/outcomes: регистрация и чтение неизменяемых body-free outcome receipts, связанных с ContextFingerprint.
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
- context.record_outcome, context.list_outcomes: неизменяемые repeat verdict, usage и cost для собственного ContextFingerprint; повтор repeatId с другим verdict является конфликтом.
- documentation_source.preview, apply, sync, cutover: импорт документации и передача владения, если эти операции настроены.
- Ресурсы MCP предоставляют ограниченную карту и содержимое проекта; сначала обнаруживайте ресурсы, а не угадывайте URI.

## Obsidian и сетевые папки

Для прямой работы откройте каталог зарегистрированного проекта как хранилище Obsidian либо разместите хранилище внутри него. Такие изменения являются изменениями рабочего пространства и обязаны соответствовать структуре и проверкам ABCM.

Для внешнего хранилища настройте источник документации. Сначала выполните preview, изучите операции create/update/move/delete/conflict, затем примените зафиксированный preview. Выполняйте cutover только после явного одобрения оператора и с ожидаемым snapshot digest. После cutover хранилище ABCM становится каноническим, а прежний источник не должен оставаться независимым писателем.

Правильно: выполнить preview, разрешить конфликты, применить изменения, проверить ScopeMap и только затем выполнить cutover.

Контрпример: вручную скопировать хранилище в управляемое зеркало и редактировать обе копии. Это создаёт разделённое владение и расхождение данных.

## Политика ошибок и завершения

- Стабильные ошибки ABCM являются данными контракта. Сообщите код, устраните причину и сохраните диагностические подробности.
- Ошибка валидации означает неверную форму запроса. Ошибка доступа означает отсутствие разрешения. Ошибка готовности карты означает, что контекст запрещено выдумывать.
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
