---
name: postgres-js-sin-pipelining
description: "Medido: postgres.js SERIALIZA las consultas dentro de una transacción — Promise.all no ahorra viajes; solo quitar sentencias baja la latencia del cobro"
metadata: 
  node_type: memory
  type: project
  originSessionId: e5ddae20-4236-42c7-a011-6eca2cb4c4e5
  modified: 2026-09-11T16:19:43.354Z
---

El 2026-09-10 se probó la «palanca 1» de la optimización del cobro (lanzar
consultas independientes con `Promise.all` dentro de `withTransaction` para
aprovechar pipelining). Medido con el hook `debug` de `createClient`: 5
consultas en `Promise.all` se emiten en una ventana de 217 ms frente a 226 ms
en secuencia. **No hay pipelining que explotar**; la palanca se implementó,
se midió y se revirtió. El dueño lo confirmó («la medición manda sobre mi
premisa»).

**Why:** con `prepare: false` (obligatorio por el pooler en modo transacción,
:6543) y una sola conexión por transacción, postgres.js espera cada respuesta.
`pg_stat_statements` NO sirve para medir esto (cuenta sentencias, no ve el
solapamiento); el instrumento correcto es contar marcas de emisión en el
cliente (`apps/api/test/_medir-viajes.test.ts`).

**How to apply:** para bajar la latencia de una operación, reducir SENTENCIAS
(inserts multi-fila con `jsonb_to_recordset`, CTE que junta acta+outbox,
lote de kardex). Resultado de la sesión: 140 → 94 viajes por venta. Lo que
sigue abierto: 5 pares `begin/commit` por venta (15 sentencias, 16 %) — varias
transacciones donde debería haber una; y la latencia VPS (Boston) ↔ base
(us-west-2), ~75 ms por viaje, que es decisión de infraestructura del dueño.
Relacionado: [[ladino-en-produccion]].
