# ADR-0051 — Notas de débito y notas de crédito directas (y el cierre contable de R-20)

- **Estado**: aceptada (orden del dueño, sprint post-auditoría 2026-09-08)
- **Fecha**: 2026-09-08
- **Módulos**: ventas · contabilidad · fiscal
- **HOMOLOGATION_IMPACT**: NO (kinds, numeración y triggers ya existentes; sin
  cambio de formato de documento ni de impuestos). El **signo** de NC/ND en el
  libro de ventas sigue VALIDAR-SENIAT como está declarado desde el módulo de
  libros.

## Contexto

La regla nº 1 del proyecto dice «una factura emitida se corrige con nota de
crédito **o débito**» — y solo existía media regla: la NC nacía únicamente como
consecuencia de una devolución con mercancía (`confirmReturn`), y la ND no
existía de punta a punta. Además, la auditoría del 2026-09-08 confirmó R-20:
**la NC emitida no genera asiento ni fila en cola** (`createInvoiceLike` nunca
llama al generador), y descubrió dos huecos conexos: `platform.ar_aging` y los
filtros de deuda servida solo miran `kind = 'invoice'` (una ND no sería deuda,
y un **recibo fiado** — posible desde el botón Fiar — tampoco), y la aplicación
de un saldo a favor asienta con la plantilla genérica del cobro, que **debita
caja** aunque no entró efectivo.

## Decisiones

### 1. Nota de débito (`createDebitNote`)

- Documento fiscal `kind = 'debit_note'`, serie «A», numeración y control
  propios del kind (`claim_document_number` / `claim_control_number` son
  kind-agnósticas; en modo `range` exige su rango cargado con
  `kind='debit_note'`).
- **Referida obligatoriamente** a una factura de la misma empresa y el mismo
  cliente en estado `issued` o `paid`. La obligación vive en el DOMINIO (como
  la política de RIF, ADR-0050): un CHECK retroactivo sobre `documents` no
  puede distinguir la NC histórica legítima.
- **Motivo obligatorio**, guardado en `notes` y en el acta de auditoría
  (`fiscal.debit_note.issued`).
- Líneas: producto + cantidad + **precio explícito** en la moneda del origen
  (intereses de mora, fletes, diferencias de precio — se modelan como
  productos/servicios del catálogo). El impuesto se resuelve con la regla
  vigente a la fecha de la ND (documento nuevo).
- **Hereda moneda y tasa del origen** (la misma razón que la NC: una nota a la
  tasa de hoy no corrige la deuda que dice corregir).
- **Sin kardex**: la ND no mueve mercancía.
- **La ND es deuda**: entra a `platform.ar_aging`, al `lo_que_me_deben` del
  resumen, al `with_debt` y al `pendiente` del statement. En la misma
  redefinición entra el **recibo** (`kind='receipt'`), que ya podía quedar
  fiado y el aging ignoraba.
- Permiso: `sales.invoice.issue` — emitir deuda nueva es facturar.

### 2. Nota de crédito directa (`createDirectCreditNote`)

- La MISMA semántica que la NC de devolución, sin el reingreso: referida
  obligatoriamente a la factura origen, motivo obligatorio, líneas =
  subconjunto de las del origen (producto + cantidad ≤ lo facturado, precio
  DEL ORIGEN), **sin movimiento de inventario** — es para descuentos y
  correcciones de precio, no para mercancía que vuelve (eso es la devolución).
- Genera `customer_credits` (saldo a favor) igual que la NC de devolución:
  **una sola semántica de NC** en todo el sistema; el crédito se aplica después
  como forma de cobro `saldo_a_favor`.
- Permiso: `sales.return.manage` — es la familia «corregir una venta emitida».

### 3. El cierre contable (R-20)

Papel contable nuevo: `customer_credit_liability` («Saldos a favor de
clientes», pasivo; VALIDAR-CONTABLE como todo el preset). Tres entradas nuevas
en `ve_basico`:

| source_kind / source_event | Asiento |
|---|---|
| `sales_credit_note` / `fiscal.credit_note.issued` | Dr ingresos (subtotal) · Dr IVA débito (tax, si ≠0) · **Cr saldos a favor de clientes (total)** |
| `sales_debit_note` / `fiscal.debit_note.issued` | Dr CxC (total) · Cr ingresos (subtotal) · Cr IVA débito (tax, si ≠0) |
| `payment_received` / `ar.credit_applied` | **Dr saldos a favor de clientes** (funcional) · Cr CxC (total) · diferencial aparte |

La tercera arregla el hueco conexo: `registerPayment` con instrumento
`saldo_a_favor` pasa a generar con `source_event = 'ar.credit_applied'` (no
entró efectivo; lo que baja es el pasivo con el cliente). El cobro normal sigue
con `ar.payment_applied` intacto.

`confirmReturn` y las dos notas nuevas llaman a `generateJournalFromDocument`.
El vocabulario `source_kind` gana `'sales_debit_note'` en sus TRES casas
(`journal_entries`, `journal_templates`, `journal_template_preset_entries` —
la trampa documentada en la migración 37). `accounting_coverage_gaps()` cubre
`credit_note` y `debit_note`; las NC emitidas ANTES de la plantilla se
**encolan en la migración** con razón explícita — quedan visibles en
«Pendientes de contabilizar», no escondidas.

### 4. Lo que NO cambia

- El libro de ventas ya lista NC y ND; el **signo** de los totales sigue sin
  aplicarse hasta tener el layout oficial (VALIDAR-SENIAT declarado).
- Modo recibos: el régimen `sin_facturacion` no permite notas
  (`allowed_kinds`); el gate del trigger responde. Corregir un recibo es un
  problema distinto, fuera de este ADR.
- `documents_amounts_chk` (importes ≥ 0): NC y ND van en positivo; el signo lo
  da el `kind`, como hasta ahora.

## Consecuencias

- Una segunda NC (directa o por devolución) sobre la misma factura convive con
  la primera: el crédito referencia a **su propia NC** como documento fuente
  (`customer_credits.source_document_id` = id de la NC), así que el
  `unique (source_document_id)` no las choca. El tope real es del dominio: la
  suma acreditada por factura no puede exceder lo facturado.
- El aging y la deuda ganan dos kinds; cualquier consulta nueva de deuda debe
  usar el trío `('invoice','receipt','debit_note')` — queda escrito aquí para
  no repetir el filtro a medias.
- La aplicación de saldo a favor deja de inflar caja en el asiento. Los cobros
  con saldo aplicados ANTES de esta migración quedaron asentados con la
  plantilla genérica; se documenta y no se reescribe historia (regla nº 2).
