import { useSesion } from "./session.js";
import { ProductsView } from "../ProductsView.js";
import { PricingView } from "../PricingView.js";
import { CustomersView } from "../CustomersView.js";
import { InventoryView } from "../InventoryView.js";
import { PurchasesView } from "../PurchasesView.js";
import { AccountingView } from "../AccountingView.js";
import { FiscalBooksView } from "../FiscalBooksView.js";
import { ExchangeDifferenceKPI } from "../SalesView.js";

/**
 * Las pantallas de la etapa anterior, montadas DENTRO del shell nuevo.
 *
 * Fase B las rediseña una a una con el patrón de ventas; mientras tanto viven
 * aquí con la base tipográfica del bloque `.legacy` (theme.css) para ser
 * usables sin tocar sus ficheros. Este archivo es la lista de lo que falta —
 * cuando quede vacío, Fase B habrá terminado.
 */
function Marco({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="legacy">{children}</div>;
}

export function LegacyProductos(): React.JSX.Element {
  const { session, empresa } = useSesion();
  return (
    <Marco>
      <ProductsView session={session} companyId={empresa.id} />
    </Marco>
  );
}
export function LegacyPrecios(): React.JSX.Element {
  const { session, empresa } = useSesion();
  return (
    <Marco>
      <PricingView session={session} companyId={empresa.id} />
    </Marco>
  );
}
export function LegacyClientes(): React.JSX.Element {
  const { session, empresa } = useSesion();
  return (
    <Marco>
      <CustomersView session={session} companyId={empresa.id} />
    </Marco>
  );
}
export function LegacyInventario(): React.JSX.Element {
  const { session, empresa } = useSesion();
  return (
    <Marco>
      <InventoryView session={session} companyId={empresa.id} />
    </Marco>
  );
}
export function LegacyCompras(): React.JSX.Element {
  const { session, empresa } = useSesion();
  return (
    <Marco>
      <PurchasesView session={session} companyId={empresa.id} />
    </Marco>
  );
}
export function LegacyContabilidad(): React.JSX.Element {
  const { session, empresa } = useSesion();
  return (
    <Marco>
      <AccountingView session={session} companyId={empresa.id} />
    </Marco>
  );
}
export function LegacyLibros(): React.JSX.Element {
  const { session, empresa } = useSesion();
  return (
    <Marco>
      <FiscalBooksView session={session} companyId={empresa.id} />
    </Marco>
  );
}
export function LegacyReportes(): React.JSX.Element {
  const { session, empresa } = useSesion();
  return (
    <Marco>
      <h2>Reportes</h2>
      <ExchangeDifferenceKPI session={session} companyId={empresa.id} />
    </Marco>
  );
}
