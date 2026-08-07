# ADR-0014 — Identidad con Supabase Auth y alcance resuelto desde memberships

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** NO

## Contexto
Un usuario puede pertenecer a varios tenants y a varias empresas dentro de un tenant, con roles
distintos en cada una (el caso típico de la firma contable que lleva veinte clientes).
Meter todo eso en un JWT de larga vida es un problema de revocación: quitarle el acceso a alguien
no debe requerir esperar a que expire su token.

## Decisión
Supabase Auth para autenticación. Un custom access token hook inyecta lo mínimo
(`user_id`, tenants a los que pertenece) para el enrutamiento rápido.

**Los permisos efectivos se resuelven contra la base de datos**, mediante funciones
`auth.ladino_company_ids()` y `auth.ladino_has_permission(perm, company_id)` que leen
`memberships`, `user_role_assignments` y `scope_bindings`. Las policies RLS usan esas funciones.
MFA obligatorio para roles críticos.

## Consecuencias
- (+) Revocación inmediata: se quita el membership y el acceso cae en la siguiente consulta.
- (+) Segregación de funciones aplicable sin reemitir tokens.
- (−) Coste por consulta en cada policy. Se mitiga con `stable` + índices adecuados; se mide
  contra el objetivo p95 < 500 ms antes de considerar cachés.
