# CI/CD — Ladino

## Pipeline de PR (todo bloqueante)

```
install (--frozen-lockfile)
  → lint
  → typecheck
  → boundaries        # fronteras de import entre paquetes
  → unit              # incluye property-based de money y accounting
  → migration test    # aplica todas las migraciones desde cero
  → pgTAP             # RLS y aislamiento entre tenants
  → integration       # Postgres efímero en contenedor
  → openapi:check     # falla si openapi.json difiere del generado desde Zod
  → build
  → SAST + dependency scan + secret scan
```

`pnpm verify` reproduce localmente el núcleo de este pipeline. Si falla en local, no se abre PR.

## Gates adicionales

| Condición | Gate |
|---|---|
| El diff toca `supabase/migrations/` | revisión de reversibilidad y expand/contract |
| El diff toca `packages/fiscal` o `02_COMPLIANCE/` | revisión fiscal + `HOMOLOGATION_IMPACT` declarado |
| El diff toca policies o permisos | auditoría de RLS |
| `fiscal_behavior_changed = true` | **producción fiscal bloqueada** hasta `homologation_status = homologated` |

El último gate es mecánico en CI. No depende de que alguien lo recuerde en el momento de
un despliegue urgente, que es exactamente cuando se olvidaría.

## Entornos

`local` → `test` → `staging` → `homologation` → `production`.

- Staging: deploy automático desde `main`.
- Producción plataforma: aprobación manual.
- Producción fiscal: requiere homologation impact review, versión fiscal aprobada,
  release manifest, digest de imagen, compatibilidad de esquema y plan de rollback.
- `homologation` usa el entorno o sandbox acordado con el proveedor/autoridad.

## Secretos

En el gestor de secretos del CI, nunca en el repositorio. Secret scanning bloqueante.
Rotación documentada. Los secretos de producción no son accesibles desde un PR de fork.

## Mobile

EAS Build con canales `staging` y `production`. Feature flags coordinados con el backend.

**OTA no puede cambiar comportamiento fiscal.** El pipeline rechaza publicar una actualización
OTA si el diff toca `packages/fiscal`. Esa regla es absoluta (ADR-0007).

## Versionado

Cada release publica el manifest de `RELEASE_AND_VERSION_HOMOLOGATION.md`: semver, git SHA,
digest, rango de migraciones, `fiscal_protocol_version`, versión mínima de mobile,
`homologation_status`.
