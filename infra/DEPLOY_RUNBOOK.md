# Runbook de despliegue — Ladino en el VPS Hostinger

> **Esta capa nunca ejecuta el deploy sola** (infra/CLAUDE.md). Este runbook PROPONE los
> comandos, en orden, con su verificación. El operador los aprueba y ejecuta. Las tres imágenes
> están probadas en local (build + smoke); lo que sigue es publicarlas y levantarlas.

## 0 · Requisitos previos (una sola vez)

- [ ] **Rotar el access token `sbp_…` y el `sb_secret`** que circularon durante el desarrollo
      (aviso repetido en los handoffs). Se rota en el dashboard de Supabase ANTES de todo lo
      demás: un despliegue con credenciales quemadas no es un despliegue serio.
- [ ] Contraseña del rol `ladino_api` y `ladino_worker` fijadas en el remoto
      (infra/README.md §Roles de servicio) y probadas contra el pooler :6543.
- [ ] En el VPS: `docker network ls` para el nombre real de la red de Traefik, y el
      `certresolver` de su configuración estática (solo LEERLA).
- [ ] DNS: `api.ladino.<dominio>` y `app.ladino.<dominio>` apuntando al VPS.
- [ ] En el VPS: `/etc/ladino/api.env` y `/etc/ladino/worker.env` desde las plantillas
      `infra/compose/*.env.example`, `chmod 600`, dueño root.
- [ ] `infra/compose/.env` desde `compose.env.example` (digests, hosts, red, resolver).

## 1 · Construir y publicar imágenes (desde la máquina de desarrollo)

```bash
V=0.2.0   # la versión que se va a registrar en releases/manifest.json

docker build -f infra/docker/Dockerfile.api    -t ghcr.io/emanuelgcq/ladino-api:$V .
docker build -f infra/docker/Dockerfile.worker -t ghcr.io/emanuelgcq/ladino-worker:$V .
docker build -f infra/docker/Dockerfile.web \
  --build-arg VITE_SUPABASE_URL=https://udacvwnhwpsdzbouhqhl.supabase.co \
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY=<publishable del proyecto> \
  --build-arg VITE_API_URL=https://api.ladino.<dominio> \
  -t ghcr.io/emanuelgcq/ladino-web:$V .

docker login ghcr.io   # PAT con write:packages
docker push ghcr.io/emanuelgcq/ladino-api:$V
docker push ghcr.io/emanuelgcq/ladino-worker:$V
docker push ghcr.io/emanuelgcq/ladino-web:$V

# Los DIGESTS (lo único que va al compose y al manifest):
for s in api worker web; do
  docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/emanuelgcq/ladino-$s:$V
done

# Registrarlos (ADR-0019/0027 §5):
pnpm release:manifest digest $V ladino-api    sha256:...
pnpm release:manifest digest $V ladino-worker sha256:...
pnpm release:manifest digest $V ladino-web    sha256:...
```

## 2 · Levantar en el VPS

```bash
# Copiar SOLO lo necesario (nunca el repo entero con node_modules):
scp infra/compose/docker-compose.ladino.yml infra/compose/.env usuario@vps:~/ladino/

ssh usuario@vps
cd ~/ladino
docker compose -p ladino -f docker-compose.ladino.yml pull
docker compose -p ladino -f docker-compose.ladino.yml up -d
```

**Prohibido en el VPS, siempre**: `docker compose down` sin `-p ladino`, `docker system prune`,
`docker network rm`, y cualquier cosa que roce el contenedor de n8n.

## 3 · Verificación (cada punto, no «a ojo»)

```bash
docker compose -p ladino ps            # los tres: Up (healthy)
docker logs ladino-api --tail 5        # api.listening
docker logs ladino-worker --tail 5     # worker.start, sin privileged_role_refused
curl -s https://api.ladino.<dominio>/v1/companies -o /dev/null -w '%{http_code}\n'   # 401 = viva y exigiendo token
curl -s https://app.ladino.<dominio>/ -o /dev/null -w '%{http_code}\n'                # 200
curl -s https://api.ladino.<dominio>/healthz -o /dev/null -w '%{http_code}\n'         # 404: las sondas NO se publican
```

La última línea es un check de SEGURIDAD, no de salud: si `/healthz` responde 200 desde fuera,
la regla del router de Traefik está mal y hay que arreglarla antes de seguir.

Login real: entrar por `https://app.ladino.<dominio>` con un usuario del proyecto remoto y abrir
el dashboard. Si responde `AUTH_BACKEND_UNAVAILABLE`, revisar `SUPABASE_JWKS_URL` en
`/etc/ladino/api.env`.

## 4 · Rollback

Las imágenes van por digest: volver atrás es poner el digest ANTERIOR (está en
`releases/manifest.json`) en `.env` y repetir `pull` + `up -d`. Las migraciones NO se revierten
con el rollback de imágenes — compatibilidad expand/contract (supabase/CLAUDE.md): la app
vieja debe funcionar contra el esquema nuevo.

## Qué queda deliberadamente FUERA de este runbook

- **Producción fiscal** (emisión con valor legal ante terceros): bloqueada por los
  VALIDAR-SENIAT abiertos (R-22/R-23/R-24) y las reglas tributarias reales cargadas con fuente.
  El sistema OPERA completo sin eso; lo que no puede es presentar libros por canal oficial ni
  afirmar alícuotas que ningún humano validó.
- Staging: el mismo compose con otros hosts y otro proyecto de Supabase, cuando exista.