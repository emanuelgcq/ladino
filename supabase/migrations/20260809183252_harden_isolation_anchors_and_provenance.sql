-- =============================================================================
-- Ladino — 5/5 · Anclas de aislamiento inmutables, TRUNCATE cerrado y
--               procedencia de fila no forjable
--
-- Módulo:         aislamiento multi-tenant (S0.3)
-- Spec:           ADR-0025 §6, §9.1 y §9.4; ADR-0006; CLAUDE.md regla 3 y §2
-- Reversibilidad: SÍ. Revertirla REABRE una fuga entre tenants; no se hace sin
--                 sustituir la defensa por otra equivalente.
-- HOMOLOGATION_IMPACT: NO
--
-- Cierra cuatro hallazgos de la auditoría de `rls-security-auditor` sobre 1-4/4.
-- Ninguno lo atrapaban los 120 tests pgTAP existentes.
--
-- ---------------------------------------------------------------------------
-- CRÍTICO — traslado de filas entre tenants
-- ---------------------------------------------------------------------------
-- Una policy de UPDATE tiene USING (evalúa la fila VIEJA) y WITH CHECK (evalúa
-- la NUEVA). **Postgres no ofrece OLD dentro de una policy**, así que ninguna
-- puede exigir que `tenant_id` no cambie.
--
-- Para un usuario con membership en DOS tenants —la firma contable que lleva
-- veinte clientes, el caso con el que ADR-0014 justifica el modelo entero— las
-- dos comprobaciones pasan:
--     USING       -> ve la fila en A                    ✓
--     WITH CHECK  -> el destino B está entre sus tenants ✓
-- y un solo UPDATE traslada la fila. Reproducido: después del traslado, un
-- usuario de B que nunca tuvo acceso a A leía la fila de A.
--
-- Las FK compuestas de ADR-0025 §9.1 NO lo impiden. Garantizan que `tenant_id`
-- y `company_id` concuerdan ENTRE SÍ; **coherencia no es inmutabilidad**.
--
-- Dos capas, por el mismo argumento de ADR-0025 §6:
--   1. GRANT por columna  -> `authenticated` no puede escribir las anclas
--   2. Trigger            -> alcanza también a service_role, que tiene BYPASSRLS
--                            y a quien ningún GRANT contiene
-- =============================================================================


-- =============================================================================
-- 1. Las anclas dejan de ser escribibles por `authenticated`
--
-- El GRANT a nivel de tabla concede UPDATE sobre TODAS las columnas, incluidas
-- las que definen a qué tenant pertenece la fila. Se sustituye por un GRANT
-- enumerado: lo que no está, no se puede escribir.
--
-- `version`, `created_at` y `created_by` quedan fuera a propósito: los gobierna
-- el trigger de la sección 4.
-- =============================================================================

revoke update on public.companies      from authenticated;
revoke update on public.branches       from authenticated;
revoke update on public.warehouses     from authenticated;
revoke update on public.cash_registers from authenticated;

grant update (legal_name, trade_name, tax_id, status)
  on public.companies to authenticated;

grant update (code, name, status)
  on public.branches to authenticated;

-- branch_id sí es editable: mover un almacén entre sucursales DE LA MISMA
-- company es una operación legítima, y la policy ya exige que la company sea
-- del usuario.
grant update (code, name, status, branch_id)
  on public.warehouses to authenticated;

grant update (code, name, status, branch_id)
  on public.cash_registers to authenticated;


-- =============================================================================
-- 2. Segunda capa: las anclas son inmutables para TODOS
--
-- El GRANT por columna no contiene a `service_role`, que es lo que usan el
-- worker y todo proceso de servidor. Igual que la inmutabilidad de ADR-0006 es
-- un trigger y no una policy, y por la misma razón.
--
-- Cambiar el tenant de una fila no es una operación que exista en el dominio:
-- si una empresa cambia de dueño, se crea en el tenant nuevo y se cierra en el
-- viejo, con rastro. Reetiquetar la fila borra la historia.
-- =============================================================================

create or replace function platform.assert_isolation_anchors_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception
      'LADINO_ANCHOR_IMMUTABLE: % no puede cambiar de tenant (% -> %). '
      'Trasladar una fila entre tenants es una fuga de aislamiento, no una '
      'actualización. Crea en el destino y cierra en el origen.',
      tg_table_name, old.tenant_id, new.tenant_id
      using errcode = 'LAD28';
  end if;

  -- `companies` no tiene company_id: ella ES la company.
  if tg_table_name <> 'companies'
     and to_jsonb(new) ? 'company_id'
     and (to_jsonb(new) ->> 'company_id') is distinct from (to_jsonb(old) ->> 'company_id') then
    raise exception
      'LADINO_ANCHOR_IMMUTABLE: % no puede cambiar de company (% -> %). '
      'La pertenencia a una empresa no se edita: se crea en la nueva y se '
      'cierra en la vieja.',
      tg_table_name, to_jsonb(old) ->> 'company_id', to_jsonb(new) ->> 'company_id'
      using errcode = 'LAD28';
  end if;

  return new;
end;
$$;

comment on function platform.assert_isolation_anchors_immutable() is
  'Impide reetiquetar el tenant_id o el company_id de una fila. Segunda capa '
  'sobre el GRANT por columna, porque el GRANT no contiene a service_role '
  '(BYPASSRLS). Cierra la fuga que las FK compuestas NO cubren: garantizan '
  'coherencia entre las dos columnas, no inmutabilidad. SQLSTATE LAD28.';

revoke execute on function platform.assert_isolation_anchors_immutable() from public;

create trigger companies_anchors_immutable
  before update on public.companies
  for each row execute function platform.assert_isolation_anchors_immutable();

create trigger branches_anchors_immutable
  before update on public.branches
  for each row execute function platform.assert_isolation_anchors_immutable();

create trigger warehouses_anchors_immutable
  before update on public.warehouses
  for each row execute function platform.assert_isolation_anchors_immutable();

create trigger cash_registers_anchors_immutable
  before update on public.cash_registers
  for each row execute function platform.assert_isolation_anchors_immutable();

-- El bloque RBAC también ancla en tenant_id, y aunque hoy `authenticated` no
-- pueda escribirlo, `service_role` sí. El mismo razonamiento aplica.
create trigger memberships_anchors_immutable
  before update on public.memberships
  for each row execute function platform.assert_isolation_anchors_immutable();

create trigger user_role_assignments_anchors_immutable
  before update on public.user_role_assignments
  for each row execute function platform.assert_isolation_anchors_immutable();

create trigger scope_bindings_anchors_immutable
  before update on public.scope_bindings
  for each row execute function platform.assert_isolation_anchors_immutable();


-- =============================================================================
-- 3. TRUNCATE — la vía que ignora a la vez las policies y reject_mutation()
--
-- Supabase trae un ALTER DEFAULT PRIVILEGES que concede `Dxtm` (TRUNCATE,
-- TRIGGER, REFERENCES) a `anon` y `authenticated` en TODA tabla nueva de
-- `public`. `auto_expose_new_tables = false` suprime `arwd`, no `Dxtm`.
--
-- Y TRUNCATE **ignora la RLS por diseño** y **no dispara** un trigger
-- `before update or delete`. Las once tablas de S0.3 se salvan solo porque 4/4
-- las enumera a mano en un `revoke all` — una lista manual sobre una superficie
-- que crece. En S0.4, `audit_events` y `journal_lines` quedarían a un olvido de
-- que `anon` pueda vaciarlas.
--
-- Ausencia de mecanismo no es prohibición (CLAUDE.md §2): se cierra por defecto,
-- para todas las tablas futuras, no tabla por tabla.
-- =============================================================================

alter default privileges in schema public
  revoke all on tables from anon, authenticated;

alter default privileges in schema public
  revoke all on sequences from anon, authenticated;

alter default privileges in schema public
  revoke all on functions from anon, authenticated;

-- Y se retira lo ya concedido a las once existentes.
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;

-- `reject_mutation()` pasa a cubrir TRUNCATE. Un trigger de TRUNCATE es
-- OBLIGATORIAMENTE `for each statement`: no hay filas que recorrer.
create or replace function platform.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'LADINO_APPEND_ONLY: % sobre %.% está prohibido. Esta tabla es append-only: '
    'se corrige con una reversión, nunca con una mutación.',
    tg_op, tg_table_schema, tg_table_name
    using errcode = 'LAD06',
          hint    = 'Genere un asiento de reversión o una nota de crédito/débito.';
end;
$$;

comment on function platform.reject_mutation() is
  'Trigger para tablas append-only. Cubre UPDATE, DELETE **y TRUNCATE**. '
  'Efectivo también para service_role, que tiene BYPASSRLS y escapa a las '
  'policies (ADR-0006, ADR-0025 §6). TRUNCATE exige un trigger FOR EACH '
  'STATEMENT y además ignora la RLS: sin él, la segunda capa tenía un hueco. '
  'SQLSTATE LAD06.';


-- =============================================================================
-- 4. Procedencia de fila no forjable — regla 3 de CLAUDE.md
--
-- `created_by`, `created_at` y `version` eran columnas ordinarias que el cliente
-- podía fijar a lo que quisiera. La auditoría insertó una fila atribuida a otro
-- usuario y fechada en 1999.
--
-- En S0.3 son tablas de estructura y el daño es menor. **El mismo DDL sobre
-- `audit_events` o `fiscal_events` en S0.4 sería falsificación de la pista de
-- auditoría**, que es lo que la regla 3 existe para impedir: "todo documento
-- fiscal y movimiento contable guarda autor, timestamp, origen y versión de
-- reglas". Un autor que el propio actor elige no es un autor.
-- =============================================================================

create or replace function platform.set_row_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();   -- null cuando corre service_role o una migración
    new.created_at := now();
    new.version    := 1;
  else
    -- La procedencia del origen es inmutable; la versión solo avanza.
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.version    := old.version + 1;
  end if;
  return new;
end;
$$;

comment on function platform.set_row_provenance() is
  'Gobierna created_by, created_at y version: el cliente no los elige. Sin esto '
  'se puede atribuir una fila a otro usuario y antedatarla — inocuo en tablas '
  'de estructura, falsificación de pista de auditoría en las append-only de '
  'S0.4. Regla 3 de CLAUDE.md.';

revoke execute on function platform.set_row_provenance() from public;

create trigger tenants_provenance
  before insert or update on public.tenants
  for each row execute function platform.set_row_provenance();
create trigger companies_provenance
  before insert or update on public.companies
  for each row execute function platform.set_row_provenance();
create trigger branches_provenance
  before insert or update on public.branches
  for each row execute function platform.set_row_provenance();
create trigger warehouses_provenance
  before insert or update on public.warehouses
  for each row execute function platform.set_row_provenance();
create trigger cash_registers_provenance
  before insert or update on public.cash_registers
  for each row execute function platform.set_row_provenance();


-- =============================================================================
-- 5. Higiene: las funciones de trigger de `platform` no son invocables
--
-- Las cuatro ladino_* llevan REVOKE desde 3/4; las de trigger conservaban
-- EXECUTE para PUBLIC por defecto. No es explotable —`anon` no tiene USAGE
-- sobre `platform` y Postgres rechaza invocar directamente una función
-- `returns trigger`— pero rompe el patrón que ADR-0025 §5 declara obligatorio,
-- y el patrón es lo que se copia.
-- =============================================================================

revoke execute on function platform.reject_mutation()               from public;
revoke execute on function platform.assert_role_scope_coherence()   from public;
revoke execute on function platform.assert_rbac_tenant_coherence()  from public;
revoke execute on function platform.assert_scope_binding_target()   from public;
revoke execute on function platform.assert_no_scope_bindings()      from public;
