-- =============================================================================
-- Ladino — El permiso de fiar dice lo que gobierna (revisión de la ola 4; R-82.1)
--
-- Módulo: clientes / ventas   Spec: docs/03_MODULES/SALES_SPEC.md, ADR-0048 (nota de la ola 4)
-- Reversible: SÍ, con datos vivos — ver «Reversibilidad» abajo.   Homologación: NO
--
-- Qué pasaba: la migración 20261004140000 sembró `sales.credit` con la descripción «Fiar en la
-- caja: …». Desde el cierre de R-82.1 la regla del fiado es UNA puerta (`exigirFiado`,
-- packages/domain/src/sales.ts) y ese permiso gobierna también la factura de administración
-- (`POST /v1/invoices`), que nace sin cobro. La descripción decía la mitad.
--
-- Qué hace: corrige el TEXTO de `public.permissions.description` para `sales.credit`. Nada más:
--   · `public.permissions` no tiene columna de nombre visible (key, description, is_scoped);
--   · no cambia `is_scoped` (el trigger `permissions_scope_coherence` no dispara);
--   · no toca `role_permissions`: lo tiene exactamente quien lo tenía.
-- Es compatible con la API saliente y con la entrante: ninguna de las dos lee esta descripción
-- (ni la pantalla de roles ni ningún endpoint la sirven hoy; es catálogo para quien lee la base).
--
-- Reversibilidad (honesta, con datos vivos): un UPDATE de vuelta al texto anterior, que está
-- literal en la migración 20261004140000. No se pierde ni se reescribe ningún otro dato: ningún
-- rol, asignación, documento ni acta cambia.
--
-- Funciones que esta migración redefine: NINGUNA.
-- =============================================================================

update public.permissions
   set description =
         'Vender a crédito (fiar en la caja y facturar a crédito): dejar una venta sin cobrar '
         'del todo, dentro del límite de fiado del cliente'
 where key = 'sales.credit';

do $$
begin
  -- El catálogo manda: si la fila no está, la migración anterior no se aplicó y esto no arregla nada.
  if not exists (select 1 from public.permissions
                  where key = 'sales.credit'
                    and description like 'Vender a crédito (fiar en la caja y facturar a crédito)%')
  then
    raise exception 'LAD37: el permiso sales.credit no existe o no quedó con su descripción';
  end if;
end $$;
