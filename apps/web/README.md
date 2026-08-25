# apps/web — la vertical delgada

Una pantalla sin diseño que ejerce la cadena **Supabase Auth → API → navegador** de extremo a
extremo: login, listado de empresas (`GET /v1/companies`), selección (`X-Company-Id` validado por
el middleware de scope) y alta (`POST /v1/companies` con `Idempotency-Key`). Existe para
descubrir problemas de contrato antes de las veinte pantallas.

## Correr la vertical en local

```bash
pnpm db:start                       # stack local (Postgres + GoTrue en 54321)
cp apps/web/env.example apps/web/.env    # y pega el anon key local (supabase status)

# La API local, como ladino_api (el seed local ya le puso contraseña):
DATABASE_URL=postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres \
LADINO_AUTH_MODE=hs256 \
SUPABASE_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long \
SUPABASE_AUTH_ISSUER=http://127.0.0.1:54321/auth/v1 \
node apps/api/dist/server.js

pnpm --filter @ladino/web dev       # Vite en http://127.0.0.1:5173
```

1. **Crear cuenta** en la pantalla (GoTrue local no exige confirmación).
2. Un usuario nuevo no tiene memberships. Siémbralo (no existe aún el caso de uso de
   onboarding; esto es fixture de desarrollo, no producto):

```sql
-- psql postgres://postgres:postgres@127.0.0.1:54322/postgres
insert into public.tenants (id, name) values (gen_random_uuid(), 'Mi tenant dev');
-- con <tenant> y el uuid del usuario (select id from auth.users):
insert into public.memberships (id, tenant_id, user_id) values (gen_random_uuid(), '<tenant>', '<user>');
insert into public.roles (id, tenant_id, key, name, requires_scope)
  values (gen_random_uuid(), null, 'dev_admin', 'Dev admin', false)
  on conflict do nothing;
insert into public.role_permissions (role_id, permission_key)
  select r.id, 'company.manage' from public.roles r where r.key = 'dev_admin'
  on conflict do nothing;
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id)
  select gen_random_uuid(), m.tenant_id, m.id, r.id, null
    from public.memberships m, public.roles r
   where m.user_id = '<user>' and r.key = 'dev_admin';
```

3. Crear la primera empresa desde la pantalla (pega el `tenant_id`) y verla en el listado.

## Reglas que esta app respeta aunque sea delgada

- **Los datos van por la API, siempre**: supabase-js se usa SOLO para la sesión. Nada de
  PostgREST desde el cliente.
- Cero reglas de negocio ni tributarias; de dinero, solo podría importar `@ladino/money/format`.
- Todo `VITE_*` es público por definición: jamás una secret key ahí.
