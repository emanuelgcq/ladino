-- Correcciones del ESCENARIO del recorrido 2026-09-24 (solo base local, nunca producción).
--
-- `pnpm recorrido restaurar` corre esto entre la carga de los datos del volcado (migración 73) y
-- las migraciones nuevas. Aquí va lo que el escenario trae mal POR los defectos que el recorrido
-- encontró y que una migración nueva rechazaría con razón (RESPUESTA del dueño: «se corrige en el
-- escenario, no en producción»). Cada corrección cita su hallazgo. Vacío hasta que haga falta.

select 1;

-- ── G-01 (ADR-0071): E2 trae dos controles repetidos ────────────────────────────────────────────
-- El recorrido cargó en E2 un rango de notas de crédito A 1-500 que pisaba el de facturas A 1-5000,
-- y las NC A-1 y A-2 salieron con los controles 1 y 2, los mismos que las facturas A-1 y A-2. La
-- migración 20260928160000 (un correlativo de control por emisor) FALLA con la lista si encuentra
-- controles repetidos: lo emitido no se renumera en silencio (regla 1). Aquí, y SOLO aquí (base
-- local del escenario, nunca producción), se le da a cada nota repetida el siguiente control libre
-- del talonario de facturas, y el rango de notas que pisaba queda anulado (sus controles nunca
-- debieron existir). El trigger de inmutabilidad se salta con `session_replication_role`. Lo que
-- impide que esto toque producción NO es el superusuario (en una base propia cualquiera lo es): es
-- que solo lo ejecuta `pnpm recorrido restaurar` contra el contenedor LOCAL (supabase_db_ladino), y
-- que solo actúa sobre la empresa E2 del escenario, por su UUID fijo. Nunca se corre en Supabase Cloud.
begin;
set local session_replication_role = replica;
do $g01$
declare
  e2 constant uuid := '01a0d548-82bb-783e-909e-643fc473d458';
  v_rango uuid;
  v_doc record;
begin
  select id into v_rango from public.fiscal_number_ranges
   where company_id = e2 and kind = 'invoice' and series = 'A' and status = 'active'
   order by range_from limit 1;
  if v_rango is null then
    return; -- el volcado no trae E2 como se espera: nada que corregir
  end if;
  for v_doc in
    select d.id from public.documents d
     where d.company_id = e2 and d.kind <> 'invoice' and d.control_number is not null
       and exists (select 1 from public.documents o
                    where o.company_id = d.company_id and o.id <> d.id
                      and o.kind = 'invoice' and o.control_number = d.control_number)
     order by d.kind, d.document_number
  loop
    update public.documents d
       set control_number = r.next_available
      from public.fiscal_number_ranges r
     where r.id = v_rango and d.id = v_doc.id;
    update public.fiscal_number_ranges set next_available = next_available + 1 where id = v_rango;
  end loop;
  -- El rango de notas que pisaba el de facturas: anulado, nunca borrado.
  update public.fiscal_number_ranges n
     set status = 'cancelled'
   where n.company_id = e2 and n.id <> v_rango and n.status <> 'cancelled'
     and exists (select 1 from public.fiscal_number_ranges f
                  where f.id = v_rango
                    and int8range(f.range_from, f.range_to, '[]')
                        && int8range(n.range_from, n.range_to, '[]'));
end
$g01$;
commit;
