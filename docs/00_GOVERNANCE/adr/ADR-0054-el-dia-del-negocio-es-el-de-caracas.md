# ADR-0054 — El día del negocio es el de Caracas, en el esquema y en el dominio

- **Estado**: aceptada (orden del dueño de resolver todos los hallazgos, 2026-09-12)
- **Fecha**: 2026-09-12
- **Módulos**: ventas · compras · inventario · tesorería · contabilidad · libros fiscales
- **HOMOLOGATION_IMPACT**: **SÍ**. Cambia el DÍA con el que se fechan asientos,
  diferenciales cambiarios y filas de los libros de ventas y de retenciones. No
  toca numeración ni formato del documento. Un documento emitido entre las
  20:00 y las 23:59 de Venezuela del último día del mes pasa a pertenecer al
  mes en que se emitió, que es lo que la norma espera.

## Contexto

CLAUDE.md §3 registra la misma familia de bugs cuatro veces. La auditoría del
2026-09-11 (hallazgos A-23, A-24, M-12, M-15, M-25, M-35) encontró la quinta y
la sexta, y esta vez en dos capas a la vez:

- **Dominio**: `posting_date`, el `occurred_on` del diferencial y la fecha con
  la que se elegía la tasa salían de `new Date().toISOString().slice(0, 10)` o
  de `${fecha}::date`: el día **UTC**. Entre las 20:00 y las 23:59 de Caracas
  ya es mañana. Una venta nocturna del 30/09 asentaba en octubre y tomaba la
  tasa del 01/10.
- **Esquema**: `sales_book`, los libros de retenciones, `ar_aging`,
  `document_balance_transaction` y `document_debt_today` cortaban con
  `issued_at::date`, `paid_at::date` o `current_date`, que dependen de la zona
  de la SESIÓN — UTC en la API (los roles `ladino_api`/`ladino_worker` no fijan
  zona). Mientras, `recompute_iva_period` (migración 46) ya cortaba con
  `at time zone 'America/Caracas'`. **El libro de ventas y la declaración de
  IVA del mismo mes no coincidían** para las ventas nocturnas de fin de mes, y
  eso es exactamente lo que compara una fiscalización.
- **Web**: fechas mostradas con `slice(0, 10)` de un ISO y fechas por defecto
  enviadas con `toISOString()`: de noche, la factura de hoy salía fechada
  mañana y la tasa se cargaba con fecha de mañana.

## Decisión

1. **Una sola definición de «día» por capa, y las tres dicen lo mismo.**
   - Esquema: `platform.caracas_day(timestamptz) → date`. Toda proyección
     fiscal y toda función de saldo lo usan (migración 48).
   - Dominio: `diaNegocio(instante)` en `packages/domain/src/dia-negocio.ts`.
     `posting_date`, `occurred_on` y el día de la tasa salen de ahí; un día
     calendario que ya viene como `YYYY-MM-DD` no se reinterpreta.
   - Web: `apps/web/src/fechas.ts` (`hoyLocal`, `fechaLocal`, `mesLocal`…)
     con `Intl.DateTimeFormat` fijado a `America/Caracas`. La zona es la del
     negocio, no la del navegador.
2. **Los filtros de fecha de la API son días calendario**, no instantes:
   `from`/`to` se validan como `YYYY-MM-DD` y se comparan contra
   `caracas_day(columna)`.
3. **Ningún `current_date` ni `::date` a secas sobre un instante** en dominio,
   rutas ni funciones fiscales. Lo que quede es defecto.

No se cambia la zona de sesión de Postgres a propósito: `now()` y las columnas
`timestamptz` siguen siendo instantes UTC (ADR-0020, `Instant`). Lo que cambia
es la conversión a día, que ahora es explícita.

## Consecuencias

- Los libros, la antigüedad y el saldo en la moneda del documento reproducen
  el mismo mes que la declaración. `libro = mayor + cola` sigue valiendo.
- **Datos históricos**: los asientos ya posteados conservan su `posting_date`
  (un asiento posted no se actualiza, regla 2). Los que hayan caído en el mes
  siguiente por este defecto se identifican con
  `select … where posting_date <> platform.caracas_day(created_at)` y se
  corrigen con reversión + asiento nuevo, caso a caso, si el contador lo pide.
  Los libros, como son proyecciones, quedan correctos de inmediato.
- Los tests que fijaban «hoy» con `toISOString().slice(0, 10)` siguen pasando
  porque el día UTC y el de Caracas coinciden de 00:00 a 19:59; el pgTAP 048
  prueba explícitamente las 23:30 de Caracas.
- `packages/core` NO recibe fechas de calendario (su regla de admisión lo
  prohíbe): el helper vive en `domain`.

## Alternativas descartadas

- **Fijar `timezone = 'America/Caracas'` en los roles de la base.** Arreglaría
  los `::date` implícitos de golpe, pero convertiría en dependencia oculta lo
  que hoy es explícito, y la misma función se comportaría distinto según quién
  la llame. Se prefiere que el corte esté escrito en cada sitio que lo necesita.
- **Guardar el día como columna.** Duplicaría el dato y volvería a plantear la
  pregunta en cada escritura.
