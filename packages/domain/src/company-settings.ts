import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork } from "@ladino/db";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import { clasificacionOfrecidaEnVentas } from "./products.js";

/**
 * LOS AJUSTES DEL NEGOCIO (migración 28): tres interruptores y un depósito por
 * defecto. Cambian la EXPERIENCIA, no la verdad fiscal — la clasificación por
 * defecto es la que el alta simple asigna a productos NUEVOS, y el contador
 * corrige por producto en /admin.
 *
 * `block_sale_without_stock` es el interruptor de la persona; la DEFENSA real
 * contra vender sin existencia sigue siendo la del kardex (LAD39 y la
 * política de inventario): este flag decide qué enseña la pantalla, no qué
 * permite el esquema.
 */
export interface CompanySettings {
  readonly sells_wholesale: boolean;
  readonly block_sale_without_stock: boolean;
  readonly allow_unidentified_sales: boolean;
  readonly default_price_list_id: string | null;
  readonly default_tax_category_code: string;
  readonly default_warehouse_id: string | null;
  /** ADR-0071 §4: el control también en el cuerpo del documento impreso. */
  readonly print_control_number: boolean;
  /** PA 00071 art. 33: tope de FILAS IMPRESAS por documento sobre forma libre (A-2). */
  readonly rows_per_free_form: number;
  /** F-05: la empresa asume el IGTF (por omisión, no). */
  readonly absorb_igtf: boolean;
}

export type SettingsError = CompanyScopeError | { code: "VALIDATION_FAILED"; message: string };

const DEFAULTS: CompanySettings = {
  sells_wholesale: false,
  block_sale_without_stock: false,
  allow_unidentified_sales: true,
  default_price_list_id: null,
  default_tax_category_code: "gravado_general",
  default_warehouse_id: null,
  print_control_number: true,
  rows_per_free_form: 15,
  absorb_igtf: false,
};

export async function getCompanySettings(
  uow: UnitOfWork,
  companyId: string,
): Promise<Result<CompanySettings, SettingsError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Leer ajustes exige un usuario real." });
  }
  // Leer no exige permiso especial: las pantallas del mostrador necesitan los
  // interruptores. El scope de visibilidad de la empresa ya lo puso el
  // middleware; aquí se revalida la membresía con el permiso más básico.
  const [fila] = await sql<CompanySettings[]>`
    select sells_wholesale, block_sale_without_stock, allow_unidentified_sales,
           default_tax_category_code, default_warehouse_id, default_price_list_id,
           print_control_number, rows_per_free_form, absorb_igtf
      from public.company_settings where company_id = ${companyId}`;
  return ok(fila ?? DEFAULTS);
}

export async function setCompanySettings(
  uow: UnitOfWork,
  companyId: string,
  cambios: { readonly [K in keyof CompanySettings]?: CompanySettings[K] | undefined },
): Promise<Result<CompanySettings, SettingsError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Cambiar ajustes exige un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, companyId, "company.settings.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  // B4 (ADR-0073): la categoría por omisión es la que reciben los productos del alta simple y de
  // la importación; tiene que poder venderse, igual que la que se elige a mano.
  if (cambios.default_tax_category_code !== undefined) {
    const ofrecida = await clasificacionOfrecidaEnVentas(sql, cambios.default_tax_category_code);
    if (!ofrecida.ok) return ofrecida;
    // Hallazgo 10: la reducida y la adicional exigen un literal o una justificación POR PRODUCTO;
    // como categoría por omisión, el alta simple y la importación nunca podrían dárselos.
    if (["gravado_reducida", "gravado_adicional"].includes(cambios.default_tax_category_code)) {
      return err({
        code: "VALIDATION_FAILED",
        message:
          "La categoría por omisión no puede ser la reducida ni la adicional: cada producto así " +
          "necesita su literal (LIVA art. 64) o su justificación (art. 61). Clasifícalos uno a uno.",
      });
    }
  }
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [fila] = await sql<CompanySettings[]>`
    insert into public.company_settings
      (company_id, tenant_id, sells_wholesale, block_sale_without_stock,
       allow_unidentified_sales, default_tax_category_code, default_warehouse_id,
       default_price_list_id, print_control_number, rows_per_free_form, absorb_igtf)
    values (${companyId}, ${scope.value.tenantId},
            ${cambios.sells_wholesale ?? DEFAULTS.sells_wholesale},
            ${cambios.block_sale_without_stock ?? DEFAULTS.block_sale_without_stock},
            ${cambios.allow_unidentified_sales ?? DEFAULTS.allow_unidentified_sales},
            ${cambios.default_tax_category_code ?? DEFAULTS.default_tax_category_code},
            ${cambios.default_warehouse_id ?? null},
            ${cambios.default_price_list_id ?? null},
            ${cambios.print_control_number ?? DEFAULTS.print_control_number},
            ${cambios.rows_per_free_form ?? DEFAULTS.rows_per_free_form},
            ${cambios.absorb_igtf ?? DEFAULTS.absorb_igtf})
    on conflict (company_id) do update set
      sells_wholesale = case when ${cambios.sells_wholesale === undefined}
        then public.company_settings.sells_wholesale else excluded.sells_wholesale end,
      block_sale_without_stock = case when ${cambios.block_sale_without_stock === undefined}
        then public.company_settings.block_sale_without_stock
        else excluded.block_sale_without_stock end,
      allow_unidentified_sales = case when ${cambios.allow_unidentified_sales === undefined}
        then public.company_settings.allow_unidentified_sales
        else excluded.allow_unidentified_sales end,
      default_tax_category_code = case when ${cambios.default_tax_category_code === undefined}
        then public.company_settings.default_tax_category_code
        else excluded.default_tax_category_code end,
      default_warehouse_id = case when ${cambios.default_warehouse_id === undefined}
        then public.company_settings.default_warehouse_id else excluded.default_warehouse_id end,
      default_price_list_id = case when ${cambios.default_price_list_id === undefined}
        then public.company_settings.default_price_list_id
        else excluded.default_price_list_id end,
      print_control_number = case when ${cambios.print_control_number === undefined}
        then public.company_settings.print_control_number
        else excluded.print_control_number end,
      rows_per_free_form = case when ${cambios.rows_per_free_form === undefined}
        then public.company_settings.rows_per_free_form
        else excluded.rows_per_free_form end,
      absorb_igtf = case when ${cambios.absorb_igtf === undefined}
        then public.company_settings.absorb_igtf
        else excluded.absorb_igtf end
    returning sells_wholesale, block_sale_without_stock, allow_unidentified_sales,
              default_tax_category_code, default_warehouse_id, default_price_list_id,
           print_control_number, rows_per_free_form, absorb_igtf`;
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${scope.value.tenantId}, ${companyId}, 'company', ${companyId},
            'company.settings.updated', 'user', now(), ${RULES_VERSION},
            ${sql.json(cambios)})`;
  return ok(fila!);
}
