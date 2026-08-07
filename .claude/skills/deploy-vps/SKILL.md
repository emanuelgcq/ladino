---
name: deploy-vps
description: Desplegar los servicios de Ladino en el VPS Hostinger detrás del Traefik existente, sin tocar el resto de la infraestructura. Úsalo para cualquier tarea de despliegue o de docker compose de Ladino.
---

# Deploy — VPS Hostinger

## Contexto de infraestructura (leer antes de nada)

El VPS es **compartido**. Ya corre Traefik como reverse proxy y **n8n**, más otros servicios.

- **n8n no se toca jamás.** Ni reiniciar, ni actualizar, ni cambiar su red. Un hook lo bloquea.
- Traefik ya existe y da servicio a otros proyectos. Ladino **solo añade labels** y se une
  a la red externa del proxy. Nunca se reinicia Traefik ni se reescribe su configuración estática.
- Todo el stack de Ladino vive bajo el project name `ladino`: `docker compose -p ladino ...`.
  Nunca un `docker compose down` sin acotar.
- Supabase es **gestionado** (cloud), no self-hosted en este VPS. La base de datos de un ERP
  fiscal no comparte host con automatizaciones.

## Servicios de Ladino

| Contenedor | Rol | Expuesto |
|---|---|---|
| `ladino-api` | API Hono | sí, vía Traefik |
| `ladino-worker` | outbox, jobs, reintentos | no |
| `ladino-fiscal` | servicio fiscal, release train propio | no (solo red interna) |
| `ladino-otel` | collector, opcional | no |

La webapp se sirve como estático (build de Vite) detrás de Traefik.

## Checklist de despliegue

1. `pnpm verify` en verde y tag de versión creado.
2. Build de imágenes con digest fijado, no `latest`.
3. Version manifest actualizado: semver, git SHA, digest, rango de migraciones,
   `fiscal_protocol_version`, versión mínima de mobile, `homologation_status`.
4. Migraciones aplicadas **antes** del arranque de la nueva imagen, y compatibles hacia atrás
   con la versión saliente (expand/contract).
5. Healthchecks y `restart: unless-stopped` en cada servicio.
6. Backup lógico verificado con fecha reciente antes de migrar.
7. Si `fiscal_behavior_changed = true` → **el deploy fiscal queda bloqueado** hasta cerrar
   el proceso de `docs/05_INFRA/RELEASE_AND_VERSION_HOMOLOGATION.md`.
8. Rollback documentado y probado antes de empezar.

## Red y puertos

- Solo 443 público, a través de Traefik.
- Postgres nunca expuesto.
- Salida permitida hacia imprenta digital y SENIAT.
- Los contenedores de Ladino se unen a la red externa del proxy y a una red interna `ladino-net`.

## Lo que esta skill nunca hace

Ejecutar el deploy por su cuenta. Prepara los archivos y **propone** los comandos.
El usuario los ejecuta o los aprueba explícitamente.
