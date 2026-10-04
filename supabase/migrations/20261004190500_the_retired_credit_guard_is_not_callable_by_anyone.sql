-- Módulo: ventas · cobros y saldos a favor   Spec: docs/00_GOVERNANCE/adr/ADR-0075-* (decisión 5)
-- Ola 4 · tercera ronda — corrige a 20261004190200 (una migración creada no se edita)
-- Reversible: SÍ (ver el pie)   Homologación: NO (un permiso de ejecución; ningún cálculo cambia)
--
-- Qué pasaba: la función del trigger platform.customer_credits_retired_stays_retired() nació en
-- 20261004190200 sin su `revoke … from public`, así que cualquier rol —`anon` incluido— tenía
-- EXECUTE sobre ella. No se puede llamar suelta (es una función de trigger) y `anon` no tiene
-- USAGE sobre el esquema `platform`, pero el gate del catálogo pregunta «¿alguna función de
-- platform es ejecutable por anon?» y su respuesta útil es CERO, sin lista de perdones (CLAUDE.md
-- §3). Lo cazó ese gate (pgTAP, la suite entera), no el test de la migración.
--
-- Qué hace: quita el EXECUTE de PUBLIC. El trigger sigue disparando para todo rol: Postgres
-- comprueba el permiso sobre la función de un trigger al CREARLO, no al dispararlo (lo ejerce el
-- pgTAP 133 como ladino_api).
-- «Expand»: no cambia nada que la API use.

revoke all on function platform.customer_credits_retired_stays_retired() from public;

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos)
--   · `grant execute … to public` la devuelve a como nació, sin tocar datos; deja en rojo el gate
--     «ninguna función de platform es ejecutable por anon».
-- =============================================================================
