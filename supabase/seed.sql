-- =============================================================================
-- Seed LOCAL. Solo corre en `supabase db reset` contra el stack de desarrollo;
-- `supabase db push` NO lo aplica al remoto.
--
-- Las contraseñas de los roles de servicio no viven en migraciones (serían un
-- secreto en git). Aquí sí, porque son las del stack local en 127.0.0.1, igual
-- que `postgres:postgres`. En el remoto las fija el operador (ADR-0031,
-- infra/README.md).
-- =============================================================================
alter role ladino_api    login password 'ladino_api';
alter role ladino_worker login password 'ladino_worker';
