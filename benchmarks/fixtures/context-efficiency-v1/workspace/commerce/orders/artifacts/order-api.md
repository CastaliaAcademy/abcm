---
id: order-api
kind: api-reference
title: API отмены заказа
taskSelectors: [order-cancellation]
projection: summary
---

Команда cancel принимает orderId, tenantId и idempotencyKey. Ответ содержит canonical status и operationId.
