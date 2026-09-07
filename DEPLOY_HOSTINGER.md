# Deploy de Ladino en Hostinger VPS

La guía gemela de la de Afterlaria, con los valores de Ladino. El patrón es el
mismo: clonar en `/opt/apps/`, unirse a la red de Traefik y construir en el
VPS. **n8n no se toca. Nunca.**

---

## Arquitectura

```
Internet
    ↓
DNS → 72.60.113.85 (Hostinger KVM 2 — 8GB RAM)
    ↓
Traefik (n8n-traefik-1) — SSL y ruteo por dominio
    ↓
Red Docker compartida: n8n_default
    ├── ladino-web       → app.TU-DOMINIO.com   (estático nginx)
    ├── ladino-api       → api.TU-DOMINIO.com   (Hono, puerto interno 3000)
    ├── ladino-worker    → (sin dominio: outbox y reapers, solo red interna)
    ├── afterlaria-*     → (intacto)
    └── n8n + workers    → (intacto, nunca tocar)
    ↓
Supabase GESTIONADO (proyecto udacvwnhwpsdzbouhqhl) — la base NO vive en el VPS
```

Diferencia clave con Afterlaria: **la base de datos no está en el VPS**. Ladino
habla con Supabase gestionado por el pooler (puerto 6543), con dos roles de
servicio dedicados y sin superusuario — la API **se niega a arrancar** si la
conectas como `postgres` (es una defensa, no un bug).

---

## ANTES de tocar el VPS (una sola vez)

1. **Contraseñas de los roles de servicio** — en el SQL Editor de Supabase
   (dashboard del proyecto `udacvwnhwpsdzbouhqhl`), como operador humano:

   ```sql
   alter role ladino_api    login password 'UNA-CONTRASEÑA-FUERTE';
   alter role ladino_worker login password 'OTRA-CONTRASEÑA-FUERTE';
   ```

   Guárdalas donde guardas tus claves. Van en `api.env` y `worker.env`.

2. **Datos del pooler** — dashboard → Connect → Transaction pooler. Copia el
   host (`aws-0-REGION.pooler.supabase.com`) y confirma el puerto **6543**.
   El usuario lleva el sufijo del proyecto: `ladino_api.udacvwnhwpsdzbouhqhl`.

3. **Publishable key** — dashboard → Settings → API keys. Es pública por
   diseño (va horneada en el bundle de la web).

4. **Service key de Storage** — dashboard → Settings → API keys (secret).
   Va SOLO en `api.env` (fotos de producto y logos).

5. **Rotar el access token `sbp_…`** que circuló durante el desarrollo
   (dashboard → Account → Access Tokens) y cualquier `sb_secret` viejo.

6. **Migraciones**: ya están aplicadas en el remoto (43/43 al 2026-09-07).
   Nada que migrar en el primer deploy.

---

## Checklist de deploy

### Paso 1 — DNS

```
Tipo: A | Nombre: api  | Valor: 72.60.113.85 | TTL: 600
Tipo: A | Nombre: app  | Valor: 72.60.113.85 | TTL: 600
```

Espera 5-10 minutos. Sin DNS propagado el SSL nunca se emite.

### Paso 2 — SSH

```bash
ssh root@72.60.113.85
```

### Paso 3 — Carpeta

```bash
mkdir -p /opt/apps/ladino
cd /opt/apps/ladino
```

### Paso 4 — Deploy key

```bash
ssh-keygen -t ed25519 -C "ladino-vps" -f ~/.ssh/ladino_deploy -N ""
cat ~/.ssh/ladino_deploy.pub
```

GitHub → repo `ladino` → Settings → Deploy keys → Add (solo lectura).

### Paso 5 — SSH config

```bash
cat >> ~/.ssh/config << 'EOF'

Host github-ladino
  HostName github.com
  User git
  IdentityFile ~/.ssh/ladino_deploy
EOF
```

### Paso 6 — Clonar

```bash
cd /opt/apps/ladino
git clone git@github-ladino:emanuelgcq/ladino.git .
```

### Paso 7 — Los TRES archivos de entorno

```bash
# 7a. Variables del compose (dominios y VITE_*; no secretos)
cp compose.env.example .env
nano .env        # dominios reales + publishable key

# 7b. Secretos de la API
cp infra/compose/api.env.example api.env
nano api.env     # DATABASE_URL con la contraseña de ladino_api y el host
                 # real del pooler; añade además:
                 #   SUPABASE_STORAGE_URL=https://udacvwnhwpsdzbouhqhl.supabase.co/storage/v1
                 #   SUPABASE_STORAGE_KEY=<service key>
                 #   CORS_ORIGIN=https://app.TU-DOMINIO.com

# 7c. Secretos del worker
cp infra/compose/worker.env.example worker.env
nano worker.env  # DATABASE_URL con la contraseña de ladino_worker

chmod 600 .env api.env worker.env
```

El `docker-compose.yml` de la raíz ya trae los valores del VPS por defecto:
red `n8n_default`, certresolver `mytlschallenge`, entrypoint `websecure`,
cero puertos expuestos, límites de memoria/CPU en los tres contenedores.

### Paso 8 — Levantar

```bash
docker compose up -d --build
```

El primer build tarda 5-10 minutos (monorepo + pnpm). Los tres contenedores:
`ladino-api`, `ladino-worker`, `ladino-web`.

### Paso 9 — Verificar que no rompió nada

```bash
docker ps
# Deben estar TODOS: n8n-*, afterlaria-*, y los tres ladino-*.
docker logs ladino-api --tail 20
# Debe decir {"evento":"api.listening"} — si dice privileged_role_refused,
# el DATABASE_URL está entrando como postgres/superusuario: corrige api.env.
docker logs ladino-worker --tail 10
```

### Paso 10 — SSL y humo (espera 2 minutos)

```bash
docker logs n8n-traefik-1 --tail 20 | grep -i "TU-DOMINIO"
curl -I https://app.TU-DOMINIO.com            # HTTP/2 200
curl -s https://api.TU-DOMINIO.com/v1/companies   # {"code":"UNAUTHENTICATED",...} = perfecto
curl -I https://api.TU-DOMINIO.com/healthz    # 404 — CORRECTO: las sondas no
                                              # se publican; las lee Docker por dentro
```

### Paso 11 — El primer usuario real

Abre `https://app.TU-DOMINIO.com` → «Crea tu cuenta con este correo» → el
registro te recibe. La tasa BCV del día llega sola (el refresco automático
corre en la API); la base remota arranca sin datos de demo.

---

## Redeploy

```bash
ssh root@72.60.113.85
cd /opt/apps/ladino
git pull origin main
docker compose up -d --build
```

Si el pull trae migraciones nuevas en `supabase/migrations/`, se aplican al
remoto ANTES del `up` (hoy se hace desde la máquina de desarrollo; las
aplicadas quedan registradas en `supabase_migrations.schema_migrations`).

---

## Troubleshooting (los de Afterlaria + los propios de Ladino)

| Síntoma | Causa y arreglo |
| --- | --- |
| SSL: `certresolver=letsencrypt does not exist` | Es `mytlschallenge`. El compose ya lo trae por defecto; si lo pisaste en `.env`, corrígelo. |
| `pnpm install` falla por versión de Node | Los Dockerfiles ya van con `node:22-alpine` fijado por digest. |
| `api.privileged_role_refused` al arrancar | El `DATABASE_URL` conecta como superusuario. Usa `ladino_api.udacvwnhwpsdzbouhqhl` con su contraseña (ADR-0031). |
| `Tenant or user not found` del pooler | El usuario del pooler lleva el sufijo del proyecto (`ladino_api.udacvwnhwpsdzbouhqhl`) y el host debe ser el del dashboard. Si el pooler rechazara los roles dedicados (VALIDAR-SUPABASE), prueba conexión directa 5432 SOLO para diagnosticar y repórtalo. |
| La web carga pero el login da error de red | `CORS_ORIGIN` en `api.env` debe ser EXACTAMENTE `https://app.TU-DOMINIO.com` (un solo origen, sin barra final). |
| `/healthz` da 404 desde afuera | Diseño, no fallo: las sondas están excluidas del router público. |
| Logo no aparece | `apps/web/public/brand/ladino-logo.png` viaja en la imagen de la web; si lo cambias, `docker compose up -d --build web`. |
| Contenedor nuevo rompe uno existente | `docker ps --format "{{.Names}}"` — ningún nombre repetido. Los routers de Ladino se llaman `ladino-api` y `ladino-web`, únicos. |

---

## Reglas de oro — las tuyas, más las de Ladino

1. **Nunca tocar `/docker/n8n/`** ni correr `docker compose down` ahí.
2. **Siempre `mytlschallenge`** como certresolver.
3. **Siempre `n8n_default` external** — nunca redefinirla.
4. **Nunca exponer puertos** — Traefik maneja todo.
5. **Nombres de router/contenedor únicos** (`ladino-*`).
6. **DNS primero, Docker después.**
7. **Nunca conectar Ladino como `postgres`** — los roles son `ladino_api` y
   `ladino_worker`, y la app se niega a arrancar con un superusuario.
8. **Los `down`/`restart` de Ladino, siempre desde `/opt/apps/ladino`** — el
   project name `ladino` acota el radio.

---

## Ladino en la tabla del VPS

| Contenedor | Dominio | Carpeta |
| --- | --- | --- |
| `ladino-api` | `api.TU-DOMINIO.com` | `/opt/apps/ladino` |
| `ladino-web` | `app.TU-DOMINIO.com` | `/opt/apps/ladino` |
| `ladino-worker` | (interno, sin dominio) | `/opt/apps/ladino` |

Los `.env` viven en `/opt/apps/ladino/` (`.env`, `api.env`, `worker.env`),
fuera de git. Si se pierden: contraseñas de roles en tu gestor, claves en el
dashboard de Supabase (`udacvwnhwpsdzbouhqhl`).
