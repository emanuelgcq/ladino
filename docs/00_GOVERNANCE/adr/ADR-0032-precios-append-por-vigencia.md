# ADR-0032 — Precios: append por vigencia, solapamiento imposible y fecha como parámetro

- **Estado:** Aceptado
- **Fecha:** 2026-08-25
- **Impacto fiscal:** NO (los importes de lista no llevan impuesto ni redondeo fiscal;
  eso es del documento y de `RoundingPolicy`, MONEY_AND_ROUNDING_SPEC §6)

## Contexto

La migración 17 es la primera vez que un módulo real persiste dinero. PRICING_MULTICURRENCY_SPEC
pone el precio FUERA del producto (`price_lists` / `price_list_items`) y no decide nada más. Las
decisiones que faltaban, con las correcciones del usuario a D-5:

1. Un precio se corrige con una fila nueva, nunca con `UPDATE` — la familia append-only de S0.4.
2. El vigente se resuelve **contra una fecha parámetro, jamás `now()`**: `now()` es hora de
   inicio de transacción (el fallo de `occurred_at` en S0.4), un precio con vigencia futura es un
   caso normal, y un documento de ayer tiene que poder recalcularse con el precio de ayer.
3. «Dos filas activas para el mismo producto y lista en el mismo instante deben ser imposibles,
   no solo improbables» — y el único `(list, product, effective_from)` **no** lo garantiza con
   `effective_to` nullable: `[ene, ∞)` y `[feb, ∞)` conviven bajo ese único.

## Opciones consideradas

1. **Único por `effective_from` + resolución determinista por `max(effective_from ≤ fecha)`.**
   Determinista, pero el solapamiento físico existe. Rechazada por el punto 3.
2. **Sin `effective_to`**: el período es `[from, siguiente_from)` por definición. Solapamiento
   inexpresable, pero retirar un precio sin sustituto exige filas lápida y contradice el
   `effective_to` nullable ya aprobado. Rechazada.
3. **EXCLUDE por rango (btree_gist) + autocierre por trigger + guardián LAD35.** — **Elegida.**

## Decisión

### El solapamiento es un constraint, no una consulta

```sql
exclude using gist (price_list_id with =, product_id with =,
                    tstzrange(effective_from, coalesce(effective_to, 'infinity'), '[)') with &&)
```

Dos vigencias que se tocan no pueden coexistir: lo garantiza Postgres, no la disciplina. El
único `(price_list_id, product_id, effective_from)` queda como cinturón de determinismo.

### Por qué el autocierre por trigger NO viola el append-only

Insertar el precio nuevo exige cerrar el abierto (`effective_to := new.effective_from`), y eso
es un `UPDATE`. La resolución: **el único camino de mutación es el que abre un INSERT.** El
trigger `BEFORE INSERT` cierra la fila abierta estrictamente anterior; el guardián
`assert_price_append_only()` (LAD35, `BEFORE UPDATE OR DELETE`) permite **exactamente una
transición** — `effective_to` de `NULL a un valor, con todas las demás columnas intactas` — y
mata todo lo demás: cambiar `amount`, mover `effective_from`, reabrir un período cerrado,
`DELETE`. Corregir un precio sigue siendo una fila nueva; lo único mutable es el fin de la
vigencia, que no reescribe historia: la completa. Además la API ni siquiera tiene `UPDATE`/
`DELETE` por GRANT — el guardián es la segunda capa para cualquier otro escritor.

El retiro SIN sustituto (el producto sale de la lista) es `platform.close_price(item, fecha)`,
`SECURITY DEFINER` con permiso propio (`price_list.manage` lo gobierna el caso de uso): mutación
sancionada, auditable, y que el guardián acepta porque es exactamente la transición permitida.

### La fecha es un parámetro

`platform.price_at(list, product, fecha)` — `STABLE`, invoker (la RLS del que pregunta), y la
fecha SIEMPRE explícita. La variante con `now()` existe solo como **negativo en pgTAP 017**: un
precio que cambió hoy da respuestas distintas para un documento fechado ayer según la función, y
ese test es la razón escrita de que nadie «simplifique» la firma.

### Forma de los importes

`amount numeric(24,8) >= 0`, sin moneda en el ítem: la moneda es de la **lista**
(`currencies.code`, tabla — añadir moneda es fila, no migración). El importe se guarda como se
cargó: ningún redondeo en el almacenamiento; `Money.of(amount, currency)` lo representa exacto
(invariante de packages/money) y el viaje base → string → `{amount, currency}` se prueba dígito
a dígito en packages/db.

## Consecuencias

- Positivas: histórico de precios reproducible por fecha; solapamiento imposible por esquema;
  el append-only es estructural (grants + guardián), no convención.
- Negativas: `btree_gist` como dependencia; el autocierre hace trabajo «invisible» en el INSERT
  (documentado en la tabla); cerrar-y-reabrir un período pasado exige fila nueva con rango
  explícito, deliberadamente incómodo.
- Revertir: quitar el EXCLUDE y el guardián son `drop constraint/trigger` — y los tests 017
  se pondrían rojos, que es el aviso.

## Verificación

pgTAP 017: solape rechazado (23P01) incluidas dos vigencias abiertas; autocierre asertado por
el dato; LAD35 sobre amount/effective_from/DELETE y 42501 por GRANT para la API; `close_price`
vivo; `price_at` contra fecha con su variante `now()` demostrando la divergencia; el viaje del
dinero al límite de 24,8 en packages/db. Variantes rotas: sin el EXCLUDE el solape entra.
