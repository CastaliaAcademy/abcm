---
id: order-retry
kind: guide
title: Повтор отмены заказа
taskSelectors: [order-cancellation]
projection: summary
---

После временного отказа отмена заказа повторяется с тем же idempotency key. Новый ключ означает новую команду и требует проверки состояния.

Форма команды описана в [[order-api]].
