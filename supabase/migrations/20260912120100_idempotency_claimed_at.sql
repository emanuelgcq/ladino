-- =============================================================================
-- Migración 49 · IDEMPOTENCIA: EL REAPER MIRA CUÁNDO SE RECLAMÓ LA LLAVE
--
-- Hallazgo A-25 de la auditoría del 2026-09-11. El reaper del worker liberaba
-- las reservas `in_progress` huérfanas por `created_at < now() - 15 min`. Pero
-- una llave `failed` o caducada se REHABILITA en T1 (idempotency.ts) sin tocar
-- `created_at`: un reintento legítimo 20 minutos después nacía «viejo», el
-- reaper lo marcaba `failed` mientras el caso de uso aún corría, T2 perdía la
-- reserva, el cliente recibía su 201 y el siguiente reintento REEJECUTABA el
-- cobro. Ventana estrecha (un tick de ~60 s dentro de una petición de ≤30 s),
-- pero real, y en el módulo que existe para que eso no pase.
--
-- `claimed_at` es el instante de la RECLAMACIÓN vigente: lo pone el insert y
-- lo renuevan las dos rehabilitaciones. El reaper mira esta columna.
-- Reversible: `drop column`; el reaper anterior seguía funcionando por
-- `created_at` (con el defecto que esta migración cierra).
-- =============================================================================

alter table public.idempotency_keys
  add column claimed_at timestamptz not null default now();

comment on column public.idempotency_keys.claimed_at is
  'Instante de la reclamación VIGENTE de la llave (insert o rehabilitación en T1). '
  'El reaper libera `in_progress` huérfanos por esta columna, no por created_at, '
  'que es la primera reclamación y no se renueva (auditoría 2026-09-11, A-25).';

-- Índice parcial para el reaper: solo lo que puede estar huérfano.
create index if not exists idempotency_keys_reaper_idx
  on public.idempotency_keys (claimed_at)
  where status = 'in_progress';
