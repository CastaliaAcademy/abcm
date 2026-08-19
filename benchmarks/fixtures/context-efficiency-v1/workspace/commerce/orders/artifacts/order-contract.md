---
id: order-contract
kind: contract
title: Контракт отмены заказа
required: true
projection: summary
---

Отмена заказа требует idempotency key. Повтор команды с тем же ключом возвращает прежний результат и не создаёт вторую отмену.
