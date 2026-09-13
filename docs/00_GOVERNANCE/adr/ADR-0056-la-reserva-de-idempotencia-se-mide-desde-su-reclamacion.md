# ADR-0056 — La reserva de idempotencia se mide desde su reclamación, no desde su nacimiento

- **Estado**: aceptada (orden del dueño de resolver todos los hallazgos, 2026-09-12)
- **Fecha**: 2026-09-12
- **Módulos**: API (middleware de idempotencia) · worker (reaper)
- **HOMOLOGATION_IMPACT**: NO.

## Contexto

ADR-0018 y ADR-0026 definen el protocolo de dos transacciones: T1 reserva la
llave (`in_progress`), el caso de uso corre, T2 guarda la respuesta. Si el
proceso muere en medio, la reserva queda huérfana y el reaper del worker la
libera a `failed` pasados 15 minutos desde `created_at`.

Pero una llave `failed` o caducada **se rehabilita en T1 sin tocar
`created_at`** (auditoría 2026-09-11, A-25). Un reintento legítimo veinte
minutos después del primer intento nace, a ojos del reaper, con veinte minutos
de antigüedad: el siguiente tick (cada ~60 s) la marca `failed` mientras el
caso de uso todavía corre; T2 pierde la reserva (`t2_claim_lost`), el cliente
recibe su 201, y el siguiente reintento con la misma llave vuelve a ejecutar
el cobro, el gasto o la entrada de stock. Ventana estrecha —un tick dentro de
una petición de ≤30 s— pero real, en el mecanismo que existe para que eso no
pase.

## Decisión

- `idempotency_keys.claimed_at timestamptz not null default now()`: el
  instante de la **reclamación vigente**. Lo pone el insert y lo renuevan las
  dos rehabilitaciones de T1 (llave `failed` y llave caducada). Migración 49.
- El reaper libera `in_progress` huérfanos por `claimed_at`, con un índice
  parcial para no barrer la tabla.
- `created_at` conserva su significado: la primera reclamación, para
  auditoría.

Además, y por el hallazgo M-24 de la misma auditoría, **T1 compara el
`endpoint`**: la misma llave con el mismo cuerpo (`{}`) en otra ruta — confirmar
dos devoluciones distintas — ya no es un replay silencioso de la primera
respuesta, sino `IDEMPOTENCY_KEY_REUSED` (409).

## Consecuencias

- Un reintento tardío se comporta como uno inmediato: 15 minutos de gracia
  desde que se reclamó, no desde que se creó la llave.
- pgTAP 049 fija la columna, su default y el índice; los tests del reaper del
  worker cubren la liberación por `claimed_at`.
- Sin cambio para los clientes: la cabecera y el protocolo son los mismos.
