# infra — cómo se despliega Ladino (S0.6a)

**Claude Code prepara los archivos y propone los comandos. El usuario aprueba y ejecuta.**
Ninguna sesión despliega por su cuenta, y nada de lo que sigue toca Traefik ni n8n.

## Qué hay

| Fichero | Qué es |
|---|---|
| `docker/Dockerfile.api` · `docker/Dockerfile.worker` | multi-stage, imagen final sin toolchain, usuario no root, healthcheck, heap acotado por debajo del límite del contenedor |
| `compose/docker-compose.ladino.yml` | los dos servicios con **límites de CPU y memoria**, red interna `ladino-net`, y `ladino-api` unido además a la red **existente** del proxy con **solo labels** |
| `compose/compose.env.example` | variables del compose (imágenes por digest, host, nombre de la red de Traefik) |
| `compose/api.env.example` · `compose/worker.env.example` | plantillas de los secretos que viven en `/etc/ladino/` del host |
| `../releases/manifest.json` | el registro de versiones; los digests se anotan aquí tras el build |

## Límites por contenedor, y por qué esas cifras

| Servicio | CPU | Memoria | Heap de Node |
|---|---|---|---|
| `ladino-api` | 1.0 | 512M | 384M |
| `ladino-worker` | 0.5 | 256M | 192M |

Son cotas de **arranque**, deliberadamente estrechas: el VPS es compartido y sin ellas el blast
radius de un fallo de Ladino es el servidor entero, n8n incluido. Se suben con datos de consumo
real, no por adelantado. El heap va por debajo del límite para que Node falle por OOM propio y
legible, no matado por el kernel a mitad de una transacción.

## Secuencia propuesta (primera release, `0.1.0`)

```bash
# 1. En el repo, con pnpm verify en verde y HEAD etiquetado
git tag v0.1.0

# 2. Construir (desde la raíz del monorepo) y obtener digests
docker build -f infra/docker/Dockerfile.api    -t ghcr.io/emanuelgcq/ladino-api:0.1.0    .
docker build -f infra/docker/Dockerfile.worker -t ghcr.io/emanuelgcq/ladino-worker:0.1.0 .
docker push ghcr.io/emanuelgcq/ladino-api:0.1.0
docker push ghcr.io/emanuelgcq/ladino-worker:0.1.0
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/emanuelgcq/ladino-api:0.1.0
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/emanuelgcq/ladino-worker:0.1.0

# 3. Anotar los digests en el manifest (y commitear)
pnpm release:manifest digest 0.1.0 ladino-api    sha256:…
pnpm release:manifest digest 0.1.0 ladino-worker sha256:…

# 4. En el VPS — consultar el Traefik EXISTENTE, no inventar
docker network ls                       # → TRAEFIK_NETWORK
# certresolver y entrypoint: los de su configuración estática, que NO se toca

# 5. En el VPS — secretos en el host, fuera de git
sudo install -d -m 700 /etc/ladino
sudo install -m 600 api.env    /etc/ladino/api.env
sudo install -m 600 worker.env /etc/ladino/worker.env

# 6. Migraciones ANTES de arrancar la imagen nueva. La 14 (roles de servicio,
#    ADR-0031) tiene que estar aplicada Y los roles tener contraseña (ver
#    §Roles de servicio, abajo) antes del primer `up -d`.

# 7. Arrancar, acotado al project name
docker compose -p ladino -f infra/compose/docker-compose.ladino.yml --env-file infra/compose/.env up -d
docker compose -p ladino ps
curl -s https://$LADINO_API_HOST/readyz
```

## Roles de servicio (ADR-0031) — antes del primer deploy

La API y el worker se conectan como **`ladino_api`** y **`ladino_worker`**, roles sin
`BYPASSRLS` que crea la migración 14 **sin contraseña** (una contraseña en una migración es un
secreto en git). Darles `LOGIN` y contraseña es del operador, una vez, en el SQL editor del
proyecto — nunca desde una sesión de Claude:

```sql
alter role ladino_api    login password '<generada, 32+ caracteres>';
alter role ladino_worker login password '<otra, distinta>';
```

Y esas van a `/etc/ladino/api.env` y `worker.env` como `ladino_api.<ref>` / `ladino_worker.<ref>`.
**`postgres.<ref>` en un `DATABASE_URL` de servicio es un error de despliegue** — y desde S0.6a
**los dos procesos se NIEGAN a arrancar** si la conexión trae `SUPERUSER`/`BYPASSRLS`
(`assertServiceRole`, ADR-0031): el error sale en el log (`*.privileged_role_refused`) en vez de
convertir la RLS en decoración en silencio.

**VALIDAR-SUPABASE:** que el pooler (Supavisor, 6543) acepte los roles dedicados. Si no,
conexión directa por 5432 para los dos servicios (la API sigue con `prepare: false`; no daña).

## Rollback

`docker compose -p ladino … up -d` con las imágenes de la release anterior del manifest. Las
migraciones son expand/contract (ADR-0019): la imagen saliente sigue funcionando con el esquema
nuevo, así que volver atrás es cambiar dos digests. **Probado antes de empezar, no después de
fallar.**

## Lo que hay que saber antes de operar (hallazgos de la auditoría de S0.6a)

- **`published` en el outbox NO significa «recibido por el SENIAT».** Con `NullTransmitter`
  montado —la implementación correcta mientras no haya régimen (ADR-0028)— todo evento fiscal
  queda `published` sin haberse transmitido a nadie. Un panel que cuente «eventos publicados»
  induce la lectura contraria. Está dicho también en `REGULATORY_STATUS.md`.
- **Rotar la clave de firma del proyecto no corta el acceso al instante.** La API cachea el
  JWKS 10 min (`cacheMaxAge`): un token firmado con la clave revocada verifica hasta 10 min
  después. Si la rotación es por compromiso, además: invalidar sesiones en Supabase.
- **La red del proxy es compartida** con n8n y los demás proyectos: `ladino-api:3000` es
  alcanzable desde cualquier contenedor de esa red sin pasar por Traefik. Los controles que
  importan (auth, rate limit por usuario, timeout) están en la aplicación; los labels solo
  gobiernan la ruta pública.
- **`.npmrc` se copia al contexto de build** porque lleva la configuración de pnpm (ADR-0022).
  Jamás un `_authToken` ahí: si algún día hace falta un registry privado, va como secret de
  BuildKit (`--mount=type=secret`), nunca por `COPY`.
- **De `deploy.resources`, en Compose sin Swarm manda `limits`**; de `reservations` solo la
  memoria actúa (como límite blando). `reservations.cpus` documenta intención, no acota.
- **Los dos servicios se conectan como el superusuario del proyecto** (`postgres.<ref>`). Es
  el hallazgo F-15 de la auditoría, **diferido a decisión**: roles dedicados `ladino_api` y
  `ladino_worker` con GRANT mínimo son una migración con rigor máximo (ADR + pgTAP), no un
  cambio de compose. Hasta entonces, un contenedor comprometido tiene BYPASSRLS.

## Lo que NO hace este despliegue todavía

- Observabilidad (ADR-0017): no hay `ladino-otel`. Los logs son JSON a stdout, rotados por Docker.
- CI que construya y publique las imágenes. Hoy el build es manual y propuesto aquí.
- `ladino-fiscal`: no existe el paquete todavía (Fase 11).
