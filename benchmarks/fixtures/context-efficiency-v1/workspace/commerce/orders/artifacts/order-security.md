---
id: order-security
kind: security-policy
title: Граница доступа к заказам
required: true
projection: summary
---

Оператор может отменять только заказы своего tenant. Идентификатор другого workspace или tenant не должен раскрываться в ошибке.
