-- =============================================================================
-- Ladino — pgTAP 49 · IDEMPOTENCIA: LA RESERVA SE MIDE DESDE SU RECLAMACIÓN
--                     (migración 49, ADR-0056)
--
-- El reaper libera `in_progress` huérfanos por `claimed_at`. Aquí se fija que
-- la columna existe con su default, que su índice parcial está, y que una
-- rehabilitación que renueva `claimed_at` deja la fila «joven» aunque
-- `created_at` sea viejo — que es exactamente el caso que el reaper mataba.
-- =============================================================================

begin;
select plan(6);

select has_column('public', 'idempotency_keys', 'claimed_at', 'idempotency_keys.claimed_at existe');
select col_not_null('public', 'idempotency_keys', 'claimed_at', 'y no admite NULL');
select col_has_default('public', 'idempotency_keys', 'claimed_at', 'y nace con default');
select has_index('public', 'idempotency_keys', 'idempotency_keys_reaper_idx',
  'el reaper tiene su índice parcial sobre claimed_at');

-- Una reserva creada hace 20 minutos y RECLAMADA hace un minuto.
-- set_row_provenance() pisa created_at con now() al insertar: para fabricar una
-- fila VIEJA se apagan los triggers solo durante la semilla (superusuario).
set local session_replication_role = replica;
insert into public.tenants (id, name) values ('aaaa0049-0000-4000-8000-00000000000a', 'Tenant 49');
insert into auth.users (id) values ('aaaa0049-0000-4000-8000-0000000000a1');
insert into public.idempotency_keys
  (tenant_id, company_id, actor_id, key, endpoint, request_hash, status, expires_at,
   created_at, claimed_at, version)
values
  ('aaaa0049-0000-4000-8000-00000000000a', null, 'aaaa0049-0000-4000-8000-0000000000a1',
   'clave-49', 'POST /v1/payments', '\x00'::bytea, 'in_progress', now() + interval '1 hour',
   now() - interval '20 minutes', now() - interval '1 minute', 1);
set local session_replication_role = default;

select is(
  (select count(*) from public.idempotency_keys
    where status = 'in_progress' and claimed_at < now() - interval '15 minutes'),
  0::bigint,
  'por claimed_at NO está huérfana: el reaper no la toca aunque created_at tenga 20 minutos');
select is(
  (select count(*) from public.idempotency_keys
    where status = 'in_progress' and created_at < now() - interval '15 minutes'),
  1::bigint,
  'CONTROL: por created_at SÍ parecía huérfana — ese era el defecto');

select * from finish();
rollback;
