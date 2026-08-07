# ADR-0002 — Supabase gestionado como system of record

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ (residencia de datos)

## Contexto
El VPS Hostinger ya aloja Traefik, n8n y otros servicios. La base de datos de un ERP fiscal
tiene requisitos de respaldo, PITR y disponibilidad que no se cumplen compartiendo host con
automatizaciones.

## Opciones
1. **Supabase self-hosted en el VPS** — control total, pero un solo host, sin réplica, y el
   blast radius de cualquier incidente incluye n8n.
2. **Postgres gestionado + Auth propio** — más trabajo de identidad.
3. **Supabase gestionado (cloud)** — Postgres, Auth, Storage, Realtime, PITR, RLS nativa.

## Decisión
Supabase gestionado. El VPS aloja únicamente `api`, `worker` y `fiscal-service`.

## Consecuencias
- (+) PITR, réplicas y backups del proveedor desde el día uno.
- (+) El VPS deja de ser punto único de fallo de los datos.
- (−) Dependencia de proveedor: se mitiga con dump lógico cifrado externo y restore probado
  trimestralmente (`docs/05_INFRA/BACKUP_AND_DISASTER_RECOVERY.md`).
- (−) **`VALIDAR-SENIAT`**: la residencia de datos fuera de Venezuela puede tener implicaciones
  para la homologación. Es una pregunta abierta y bloqueante para producción fiscal, no para
  desarrollo de Fases 1–3.

## Verificación
Restore completo probado antes de cualquier envío a homologación.
