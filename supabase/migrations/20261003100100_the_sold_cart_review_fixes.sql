-- =============================================================================
-- Ladino — los arreglos de la revisión de la cuenta vendida (ADR-0076, ola 3)
--
-- Módulo: POS · ADR-0076 · corrige la migración 20261003100000 (ya aplicada: no se edita).
-- Reversible: SÍ (ver el final). Homologación: NO.
--
-- Una migración que arregla otra lleva su propia auditoría (CLAUDE.md §3). Lo que cambia:
--   1. `platform.pos_cart_sold_is_final()` era ejecutable por PUBLIC (y así por anon): el
--      privilegio por omisión de toda función nueva. Es una función de trigger: nadie la llama
--      directamente. Se revoca como al resto de `platform` (pgTAP 005).
--   2. `pos.carts.manage` sale del ENCARGADO. Decidido por criterio (§2.8: el encargado no vende;
--      cada oficio hace su trabajo): cobrar la cuenta de otra persona es de quien vende y
--      administra — dueño y administrativo. Además rompía la aserción de HEAD
--      `040_named_roles_test.sql:158` (el encargado tiene 15 permisos). Alternativa: dejárselo y
--      cambiar esa aserción, que exige aprobación del dueño.
--   3. El detalle de la venta lee la lápida por `sale_id` («Armó la cuenta», O-02): índice
--      parcial para esa búsqueda.
--   4. La REVERSIÓN que documentaba la cabecera de la 100000 decía «borrar las lápidas» antes de
--      quitar las columnas. Ya no: la lápida es la constancia de quién armó cada venta del POS y
--      el detalle de la venta la enseña. Se corrige aquí, en el catálogo, con un COMMENT.
--
-- Datos vivos: (2) borra a lo sumo una fila de `role_permissions` (el par global encargado ↔
-- pos.carts.manage, sembrado por la 100000); ninguna asignación por tenant depende de él. El
-- resto no toca filas.
-- =============================================================================

-- ── 1. La función de trigger no es una API ───────────────────────────────────
revoke execute on function platform.pos_cart_sold_is_final() from public, anon, authenticated;

-- ── 2. Cuentas ajenas: dueño y administrativo ────────────────────────────────
delete from public.role_permissions rp
 using public.roles r
 where r.id = rp.role_id and r.tenant_id is null
   and r.key = 'store_manager' and rp.permission_key = 'pos.carts.manage';

do $$
begin
  if (select count(*) from public.role_permissions rp
        join public.roles r on r.id = rp.role_id and r.tenant_id is null
       where rp.permission_key = 'pos.carts.manage'
         and r.key in ('owner', 'back_office')) <> 2 then
    raise exception 'LAD37: pos.carts.manage no quedó en dueño y administrativo';
  end if;
  if exists (select 1 from public.role_permissions rp
               join public.roles r on r.id = rp.role_id and r.tenant_id is null
              where rp.permission_key = 'pos.carts.manage'
                -- los roles CON NOMBRE del catálogo; los globales de prueba de los E2E no cuentan
                and r.key in ('cashier', 'store_manager', 'accountant', 'warehouse_ops')) then
    raise exception 'LAD37: pos.carts.manage quedó en cajero, encargado, contador o almacén';
  end if;
end $$;

-- ── 3. La venta encuentra su lápida ──────────────────────────────────────────
create index pos_carts_sale_idx on public.pos_carts (company_id, sale_id)
  where sale_id is not null;

-- ── 4. La reversión, corregida en el catálogo ────────────────────────────────
comment on table public.pos_carts is
  'Cuentas abiertas del POS (migración 44) y, desde ADR-0076, las LÁPIDAS de las cobradas '
  '(sold_at + sale_id): no se editan, no se borran y no se purgan; con created_by dicen quién '
  'armó cada venta, y el detalle de la venta lo enseña. REVERSIÓN de 20261003100000: NO borrar '
  'las lápidas. Quitar el trigger y las columnas exige antes conservar la autoría en otro sitio '
  '(p. ej. una tabla de autoría por venta); borrarlas pierde un dato que se muestra.';

-- =============================================================================
-- REVERSIÓN de esta migración (otra migración): `grant execute ... to public` (no hace falta:
-- es un trigger), volver a insertar el par encargado ↔ pos.carts.manage, `drop index
-- pos_carts_sale_idx` y `comment on table ... is null`. Ninguna pierde datos.
-- =============================================================================
