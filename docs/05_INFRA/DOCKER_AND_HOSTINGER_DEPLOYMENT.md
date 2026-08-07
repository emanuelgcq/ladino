# Docker y Hostinger — Ladino

## El VPS es compartido. Esto manda sobre todo lo demás

El servidor ya está en producción con **Traefik** como reverse proxy y **n8n**, además de
otros servicios del equipo.

- **n8n no se toca. Nunca.** Ni reiniciar, ni actualizar, ni cambiar su red ni sus volúmenes.
  Un hook de Claude Code bloquea cualquier comando que lo mencione.
- **Traefik ya existe.** Ladino **solo añade labels** y se une a la red externa del proxy.
  No se reinicia Traefik, no se reescribe su configuración estática, no se cambian sus
  certificados ni sus entrypoints.
- Todo el stack de Ladino corre bajo project name `ladino`: `docker compose -p ladino ...`.
  Nunca un `down` sin acotar, nunca `docker system prune`, nunca `network prune`.
- **Supabase es gestionado** (ADR-0002), no self-hosted aquí.

## Contenedores de Ladino

| Contenedor | Rol | Expuesto |
|---|---|---|
| `ladino-api` | API Hono | sí, vía Traefik |
| `ladino-worker` | outbox, jobs, reintentos | no |
| `ladino-fiscal` | servicio fiscal, release train propio (ADR-0003) | solo red interna |
| `ladino-otel` | collector OpenTelemetry (opcional) | no |

La webapp es un build estático de Vite servido por el mismo Traefik.

## Reglas de contenedor

- Imágenes **por digest**, nunca `latest`. El digest va en el version manifest.
- Dockerfile multi-stage, imagen final sin toolchain de build, usuario no root.
- `healthcheck` y `restart: unless-stopped` en todos.
- **Límites de CPU y memoria obligatorios.** El VPS es compartido: un consumo desmedido de
  Ladino degrada n8n. Sin límites, el blast radius es el servidor entero.
- Los volúmenes **nunca** son la única copia de un dato. Backup externo siempre.
- Secretos por variable de entorno del host o gestor de secretos. Jamás en la imagen ni en git.

## Red

- Solo **443** público, a través de Traefik.
- Postgres jamás expuesto (además es gestionado y fuera del VPS).
- Endpoints de administración y métricas protegidos y no públicos.
- Salida permitida hacia imprenta digital y SENIAT.
- Dos redes: la externa del proxy (compartida, solo `ladino-api`) y `ladino-net` interna.

## Despliegue

1. `pnpm verify` en verde y tag de versión creado.
2. Build con digest fijado y version manifest actualizado
   (`05_INFRA/RELEASE_AND_VERSION_HOMOLOGATION.md`).
3. Migraciones aplicadas **antes** del arranque de la nueva imagen, compatibles hacia atrás
   con la versión saliente (expand/contract, ADR-0019).
4. Backup lógico verificado y reciente antes de migrar.
5. Rollback documentado y probado **antes** de empezar, no después de fallar.
6. Si `fiscal_behavior_changed = true`, el despliegue fiscal queda bloqueado hasta cerrar el
   gate de homologación.

Claude Code **prepara** los archivos y **propone** los comandos. El usuario aprueba y ejecuta.
Ninguna sesión despliega por su cuenta.

## Limitación aceptada

Un solo VPS no da alta disponibilidad real. Es aceptable para las fases iniciales, pero el
objetivo de 99.9% de disponibilidad para emisión fiscal exige revisitar esta decisión
(ADR-0008) antes de producción fiscal. Está registrado, no olvidado.
