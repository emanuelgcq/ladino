-- =============================================================================
-- EL SNAPSHOT DEL EMISOR (R-05, lado emisor) + DOMICILIO FISCAL DEL NEGOCIO
--
-- PA 00071 art. 13.5: la factura lleva nombre o razón social, RIF y DOMICILIO
-- FISCAL del emisor — y cuando se emite desde una sucursal, también el de la
-- sucursal. Hasta hoy `companies` ni siquiera modelaba su domicilio (deuda
-- declarada en HANDOFF desde la Fase C), y el documento REFERENCIABA al
-- emisor en vez de copiarlo: un cambio de razón social reescribiría quién
-- emitió las facturas del trimestre pasado. R-05 lo prohíbe; el lado cliente
-- se cerró en la migración 33 y este es el mismo patrón, lado emisor.
--
-- Todo nullable y SIN default: las empresas existentes no saben su domicilio
-- (lo pide /empezar) y los documentos anteriores no saben qué emisor eran ese
-- día — un backfill sería inferencia sobre el pasado (misma decisión que las
-- migraciones 27 y 33). El PDF hace coalesce al emisor VIVO solo para
-- documentos pre-migración, y lo dice en su código.
-- =============================================================================

-- ── 1. El domicilio fiscal, como dato del maestro ───────────────────────────

alter table public.companies add column fiscal_address text;
comment on column public.companies.fiscal_address is
  'Domicilio fiscal del emisor (PA 00071 art. 13.5). NULL hasta que el negocio '
  'lo cargue (/empezar lo pide): un domicilio inventado en una factura es peor '
  'que uno ausente con aviso.';

alter table public.branches add column fiscal_address text;
comment on column public.branches.fiscal_address is
  'Domicilio de la sucursal (PA 00071 art. 13.5: la factura emitida desde '
  'sucursal lleva el de la matriz Y el de la sucursal).';

-- ── 2. El snapshot del emisor en el documento ───────────────────────────────

alter table public.documents
  add column issuer_name_snapshot           text,
  add column issuer_tax_id_snapshot         text,
  add column issuer_address_snapshot        text,
  add column issuer_branch_address_snapshot text;

comment on column public.documents.issuer_name_snapshot is
  'Razón social del emisor EL DÍA DE ESTE DOCUMENTO (PA 00071 art. 13.5, '
  'R-05). NULL solo en documentos anteriores a la migración 34.';
comment on column public.documents.issuer_tax_id_snapshot is
  'RIF del emisor al crear el documento, NORMALIZADO como el del cliente '
  '(mayúsculas, sin separadores): los guiones son presentación.';
comment on column public.documents.issuer_address_snapshot is
  'Domicilio fiscal del emisor al crear el documento. NULL si la empresa aún '
  'no lo había cargado — el PDF lo omite y el pie VALIDAR-SENIAT lo delata.';
comment on column public.documents.issuer_branch_address_snapshot is
  'Domicilio de la sucursal emisora, si el documento tiene branch. NULL si no.';

-- Congelado, igual que el del cliente (LAD68): el snapshot se escribe con el
-- documento y no se toca más. Trigger propio en vez de reescribir el de la 33
-- porque una migración aplicada no se edita.
create function platform.documents_issuer_snapshot_freeze()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.issuer_name_snapshot, new.issuer_tax_id_snapshot,
      new.issuer_address_snapshot, new.issuer_branch_address_snapshot)
     is distinct from
     (old.issuer_name_snapshot, old.issuer_tax_id_snapshot,
      old.issuer_address_snapshot, old.issuer_branch_address_snapshot)
  then
    raise exception
      'LAD68: el snapshot del EMISOR de un documento está congelado (R-05): '
      'quién emitió no se reescribe — se corrige con nota de crédito'
      using errcode = 'LAD68';
  end if;
  return new;
end;
$$;
revoke execute on function platform.documents_issuer_snapshot_freeze() from public;

create trigger documents_issuer_snapshot_freeze
  before update on public.documents
  for each row execute function platform.documents_issuer_snapshot_freeze();

-- ── 3. Lo que esta migración GARANTIZA sobre sí misma (LAD52) ───────────────
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'documents'
       and column_name like 'issuer_%_snapshot' and column_default is not null
  ) then
    raise exception 'LAD52: un snapshot con DEFAULT backfillea el pasado (migraciones 27 y 33, misma regla)';
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and ((table_name = 'companies' and column_name = 'fiscal_address')
         or (table_name = 'branches' and column_name = 'fiscal_address'))
       and (is_nullable <> 'YES' or column_default is not null)
  ) then
    raise exception 'LAD52: el domicilio nace NULL honesto — inventarlo por default es peor que pedirlo';
  end if;
end $$;
