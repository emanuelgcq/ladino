import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  CreditCard,
  ArrowLeftRight,
  Landmark,
  Lock,
  Plus,
  RefreshCw,
  Smartphone,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { useSesion } from "../../app/session.js";
import { useAccionPedida } from "../../app/accion-pedida.js";
import { errorDePersona } from "../../lib.js";
import { mostrarImporte } from "../../money.js";
import { compararImportes } from "../../components/decimal-compare.js";
import {
  FALTA_LA_TASA,
  estadoDeTotal,
  nominalPorMoneda,
  type MotivoSinTotal,
} from "../../components/deuda.js";
import { ETIQUETA_FORMA } from "../../components/formas-de-pago.js";
import { Button } from "../../ui/button.js";
import { Card, CardContent } from "../../ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { Switch } from "../../ui/switch.js";
import { useToast } from "../../ui/toast.js";
import { FormField, MoneyInput, importeLimpio, importeValido } from "../../components/forms.js";
import { ConfirmarSobregiro, esSinSaldo } from "../../components/sobregiro.js";
import { fechaLocal } from "../../fechas.js";
import { mostrarTasa, tasaLimpia } from "../../tasa.js";

/**
 * MI DINERO (Fase C, PARTE 11): «¿dónde está mi plata?» en una pantalla.
 * Tasa del día arriba (con «Sigue igual» a un toque), lo que me deben y lo
 * que debo, las cuentas con su saldo, cerrar la caja y las formas de pago.
 * NINGÚN número se calcula aquí: todos vienen del servidor como string.
 */

interface Cuenta {
  id: string;
  name: string;
  currency: string;
  kind: "cash" | "bank" | "wallet";
  is_active: boolean;
  is_system: boolean;
  balance: string;
}
interface NominalDeMoneda {
  currency: string;
  nominal: string;
}
interface Resumen {
  functional_currency: string;
  /**
   * null = sin ar.read / ap.read (la tarjeta no se pinta) O falta la tasa de hoy para valorar lo
   * que está en divisa (se pinta y lo dice, con el nominal por moneda). Cuál, en `…_motivo`: la
   * decisión es `estadoDeTotal`. Los campos nuevos son opcionales: una API anterior no los manda.
   */
  lo_que_me_deben: string | null;
  lo_que_me_deben_motivo?: MotivoSinTotal | null;
  lo_que_me_deben_por_moneda?: NominalDeMoneda[];
  lo_que_debo: string | null;
  lo_que_debo_motivo?: MotivoSinTotal | null;
  lo_que_debo_por_moneda?: NominalDeMoneda[];
}
interface TasaDelDia {
  rate: string;
  rate_date: string;
  source: string;
  es_de_hoy: boolean;
}
/** Una fila del informe de ADR-0067 §4. */
interface CaidaDeDinero {
  kind: string;
  movement_id: string;
  occurred_on: string;
  instrument: string | null;
  amount: string;
  currency: string;
  account_id: string;
  account_name: string;
  problem: "sin_asignar" | "familia_no_corresponde";
}

interface FormaDePago {
  id: string;
  name: string;
  kind: string;
  account_id: string;
  is_active: boolean;
}
interface Cierre {
  id: string;
  account_id: string;
  closing_date: string;
  expected_amount: string;
  counted_amount: string;
  difference: string;
  /** J-02: lo que llevó la caja de negativo a cero (lo puso el dueño); null si no estaba en negativo. */
  owner_contribution: string | null;
  reason: string | null;
  currency: string;
}

const ICONO_CUENTA = { cash: Banknote, bank: Landmark, wallet: Smartphone } as const;

/** Un bloque que no pudo cargar: el motivo y el reintento, nunca un «…» eterno. */
function ErrorDeBloque({
  titulo,
  error,
  onReintentar,
}: {
  titulo: string;
  error: unknown;
  onReintentar: () => void;
}): React.JSX.Element {
  return (
    <Card role="alert">
      <CardContent className="py-6 text-center">
        <p className="font-medium">{titulo}</p>
        <p className="mx-auto mt-1 max-w-sm text-[0.9rem] text-muted-foreground">
          {errorDePersona(error)}
        </p>
        <Button variant="secondary" className="mt-3" onClick={onReintentar}>
          Reintentar
        </Button>
      </CardContent>
    </Card>
  );
}

const TIPOS_CUENTA = [
  { value: "cash", label: "Caja (efectivo)" },
  { value: "bank", label: "Banco" },
  { value: "wallet", label: "Billetera digital (Zelle, USDT…)" },
];
const MONEDAS = [
  { value: "VES", label: "Bolívares (Bs.)" },
  { value: "USD", label: "Dólares (USD)" },
];
/**
 * En qué moneda cobra cada forma. Espejo de `MONEDA_DE_INSTRUMENTO` en el dominio: la
 * regla vive allá (ADR-0062 §2), esto solo filtra la lista para no ofrecer lo imposible.
 * `null` = la forma sirve para cualquier moneda (tarjeta, otra).
 */
const MONEDA_DE_FORMA: Record<string, "funcional" | "USD" | null> = {
  efectivo_bs: "funcional",
  pago_movil: "funcional",
  transferencia: "funcional",
  punto_venta: "funcional",
  cashea: "funcional",
  efectivo_usd: "USD",
  zelle: "USD",
  usdt: "USD",
  tarjeta: null,
  otro: null,
};

const FORMAS = [
  { value: "efectivo_bs", label: "Efectivo en bolívares" },
  { value: "efectivo_usd", label: "Efectivo en dólares" },
  { value: "pago_movil", label: "Pago móvil" },
  { value: "transferencia", label: "Transferencia" },
  { value: "punto_venta", label: "Punto de venta" },
  { value: "tarjeta", label: "Tarjeta" },
  { value: "zelle", label: "Zelle" },
  { value: "usdt", label: "USDT" },
  { value: "cashea", label: "Cashea" },
  { value: "otro", label: "Otra" },
];

export function Dinero(): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const qc = useQueryClient();
  // ADR-0048: con treasury.read se ve TODO el dinero; con solo cash.close
  // (el encargado) la pantalla se reduce a la tasa del día y el cierre de SU
  // caja — el servidor ya le devuelve únicamente las cuentas de efectivo.
  const puedeDinero = puede("treasury.read");

  const resumen = useQuery({
    queryKey: ["negocio-resumen", empresa.id],
    enabled: puedeDinero,
    queryFn: () => llamar<Resumen>("/v1/negocio/resumen"),
  });
  /**
   * LA TASA TIENE SU LECTURA (N-05). Salía del resumen, que exige treasury.read y aquí ni se pide
   * sin él: al encargado la tarjeta le decía «Todavía no hay tasa BCV» habiéndola. Ahora la lee
   * todo el que entra a esta pantalla, y «no hay» solo se dice cuando el servidor contestó que no
   * hay: cargando y error tienen su propio texto.
   */
  const tasa = useQuery({
    queryKey: ["negocio-tasa", empresa.id],
    queryFn: () => llamar<{ tasa_del_dia: TasaDelDia | null }>("/v1/negocio/tasa"),
  });
  const cuentas = useQuery({
    queryKey: ["cuentas", empresa.id],
    queryFn: () => llamar<{ accounts: Cuenta[] }>("/v1/treasury/accounts"),
  });
  const formas = useQuery({
    queryKey: ["formas-pago", empresa.id],
    queryFn: () => llamar<{ methods: FormaDePago[] }>("/v1/payment-methods"),
  });
  /**
   * DÓNDE CAYÓ EL DINERO QUE NADIE ELIGIÓ (ADR-0067 §4). Informe, no invariante: su respuesta
   * correcta no es cero, porque «Sin asignar» es legítima mientras no exista una cuenta de esa
   * familia. Lo que haya que mover lo mueve una persona con «Mover plata», ahí abajo.
   */
  const caidas = useQuery({
    queryKey: ["donde-cayo", empresa.id],
    enabled: puedeDinero,
    retry: false,
    queryFn: () => llamar<{ items: CaidaDeDinero[] }>("/v1/treasury/landing-gaps"),
  });

  const cierres = useQuery({
    queryKey: ["cierres", empresa.id],
    enabled: puedeDinero,
    queryFn: () => llamar<{ items: Cierre[] }>("/v1/cash-closings"),
  });

  const recargar = () => {
    void qc.invalidateQueries({ queryKey: ["negocio-resumen", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["negocio-tasa", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["cuentas", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["cierres", empresa.id] });
  };

  const lista = cuentas.data?.accounts ?? [];
  // P-06: «Cerrar caja» de la paleta llega con `?accion=cerrar-caja`. Con UNA sola caja se abre
  // su cierre; con varias, la persona elige cuál (cada una tiene su botón «Cerrar la caja»).
  const [cierrePedido, setCierrePedido] = useState<{ cuenta: string; vez: number } | null>(null);
  useAccionPedida("cerrar-caja", cuentas.isSuccess, () => {
    const cajas = lista.filter((c) => c.kind === "cash" && !c.is_system);
    if (puede("cash.close") && cajas.length === 1) {
      setCierrePedido((antes) => ({ cuenta: cajas[0]!.id, vez: (antes?.vez ?? 0) + 1 }));
    }
  });
  const funcional = resumen.data?.functional_currency ?? "VES";
  // La deuda vive en la administración: el enlace solo para quien puede
  // entrar ahí; a los demás se les dice, sin puerta que no abre.
  const puedeVerDeuda = puede(["customer.tax_id.manage", "accounting.read"]);
  const deben = estadoDeTotal(resumen.data?.lo_que_me_deben, resumen.data?.lo_que_me_deben_motivo);
  const debo = estadoDeTotal(resumen.data?.lo_que_debo, resumen.data?.lo_que_debo_motivo);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold">Mi dinero</h1>

      <TarjetaTasa
        tasa={tasa.data === undefined ? undefined : tasa.data.tasa_del_dia}
        error={tasa.isError ? tasa.error : null}
        onReintentar={() => void tasa.refetch()}
        onCambio={recargar}
      />

      {puedeDinero && resumen.isError && (
        <ErrorDeBloque
          titulo="No se pudo cargar el resumen"
          error={resumen.error}
          onReintentar={() => void resumen.refetch()}
        />
      )}

      {puedeDinero && !resumen.isError && (
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Sin ar.read / ap.read la tarjeta no se pinta; sin tasa SÍ, y lo dice (estadoDeTotal). */}
          {deben !== "oculta" && (
            <Card>
              <CardContent className="py-4">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <ArrowDownToLine className="size-4" />
                  <span className="text-[0.9rem]">Lo que me deben</span>
                </div>
                <TotalDeDeuda
                  estado={deben}
                  importe={resumen.data?.lo_que_me_deben ?? null}
                  moneda={funcional}
                  porMoneda={resumen.data?.lo_que_me_deben_por_moneda}
                  nota="Lo que te deben en dólares va a la tasa BCV de hoy."
                />
                {puedeVerDeuda ? (
                  <Link
                    to="/admin/clientes?orden=vencido"
                    className="text-[0.85rem] text-accent-soft-foreground hover:underline"
                  >
                    Ver quién me debe
                  </Link>
                ) : (
                  <p className="text-[0.85rem] text-muted-foreground">
                    El detalle lo ve quien administra el negocio.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
          {debo !== "oculta" && (
            <Card>
              <CardContent className="py-4">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <ArrowUpFromLine className="size-4" />
                  <span className="text-[0.9rem]">Lo que debo</span>
                </div>
                <TotalDeDeuda
                  estado={debo}
                  importe={resumen.data?.lo_que_debo ?? null}
                  moneda={funcional}
                  porMoneda={resumen.data?.lo_que_debo_por_moneda}
                  nota="Lo que debes en dólares va a la tasa BCV de hoy."
                />
                {/* H-10: lo que se debe son las facturas de proveedores, no los gastos. */}
                <Link
                  to="/compras?ver=compras"
                  className="text-[0.85rem] text-accent-soft-foreground hover:underline"
                >
                  Ver qué debo
                </Link>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[1.05rem] font-semibold">
            {puedeDinero ? "Mis cuentas" : "La caja"}
          </h2>
          {puede("treasury.account.manage") && <CrearCuenta onCreada={recargar} />}
        </div>
        {cuentas.isLoading ? (
          <p className="text-muted-foreground">Cargando…</p>
        ) : cuentas.isError ? (
          <ErrorDeBloque
            titulo="No se pudieron cargar las cuentas"
            error={cuentas.error}
            onReintentar={() => void cuentas.refetch()}
          />
        ) : lista.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <Wallet className="mx-auto size-8 text-faint-foreground" />
              <p className="mt-2 font-medium">Todavía no tienes cuentas</p>
              <p className="mx-auto mt-1 max-w-sm text-[0.9rem] text-muted-foreground">
                Una cuenta es donde vive tu plata: la caja del negocio, tu banco, tu Zelle. Crea la
                primera y cada venta y cada gasto sabrán de dónde entra y sale.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {lista.map((c) => (
              <TarjetaCuenta
                key={c.id}
                cuenta={c}
                cuentas={lista}
                onCerrada={recargar}
                cierrePedido={cierrePedido?.cuenta === c.id ? cierrePedido.vez : 0}
              />
            ))}
          </div>
        )}
      </section>

      {puedeDinero && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[1.05rem] font-semibold">Formas de pago</h2>
            {/* Crear una forma exige `treasury.account.manage` (createPaymentMethod
                en packages/domain): el botón solo para quien lo tiene. */}
            {puede("treasury.account.manage") && (
              <CrearFormaDePago
                cuentas={lista}
                onCreada={() =>
                  void qc.invalidateQueries({ queryKey: ["formas-pago", empresa.id] })
                }
              />
            )}
          </div>
          <p className="text-[0.85rem] text-muted-foreground">
            Cada forma apunta a una cuenta: cuando cobras con ella, la plata entra ahí sola.
          </p>
          {formas.isLoading ? (
            <p className="text-muted-foreground">Cargando…</p>
          ) : formas.isError ? (
            <ErrorDeBloque
              titulo="No se pudieron cargar las formas de pago"
              error={formas.error}
              onReintentar={() => void formas.refetch()}
            />
          ) : (formas.data?.methods ?? []).length === 0 ? (
            <p className="text-[0.9rem] text-faint-foreground">
              Sin formas configuradas, los cobros van a «Sin asignar» y luego hay que repartirlos.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {(formas.data?.methods ?? []).map((f) => {
                const cuenta = lista.find((c) => c.id === f.account_id);
                return (
                  <FormaDePagoChip
                    key={f.id}
                    forma={f}
                    cuentaNombre={cuenta?.name ?? "?"}
                    onCambio={() =>
                      void qc.invalidateQueries({ queryKey: ["formas-pago", empresa.id] })
                    }
                  />
                );
              })}
            </div>
          )}
        </section>
      )}

      {puedeDinero && (caidas.data?.items.length ?? 0) > 0 && (
        <section className="space-y-3" aria-labelledby="donde-cayo-titulo">
          <div className="flex items-center gap-2">
            <TriangleAlert className="size-5 text-warning-soft-foreground" />
            <h2 id="donde-cayo-titulo" className="font-medium">
              Dinero que no sabemos dónde ponerte
            </h2>
            <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[0.78rem] text-warning-soft-foreground tabular-nums">
              {caidas.data!.items.length}
            </span>
          </div>
          <p className="text-[0.85rem] text-muted-foreground">
            Estos movimientos cayeron en «Sin asignar», o en una cuenta que no cuadra con la forma
            de pago —efectivo que salió de un banco, por ejemplo—. No están perdidos ni mal
            contados: están en el sitio equivocado. Muévelos con «Mover plata», ahí abajo.
          </p>
          <div className="divide-y divide-border rounded-md border border-border bg-surface">
            {caidas.data!.items.slice(0, 12).map((c) => (
              <div
                key={c.movement_id}
                className="flex flex-wrap items-center gap-2 px-3 py-2 text-[0.9rem]"
              >
                <span className="w-24 shrink-0 text-[0.82rem] text-muted-foreground">
                  {fechaLocal(c.occurred_on)}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {c.kind}
                  {c.instrument === null
                    ? ""
                    : " · " + (ETIQUETA_FORMA[c.instrument] ?? c.instrument)}
                </span>
                <span className="font-mono text-[0.85rem] tabular-nums">
                  {mostrarImporte({ amount: c.amount, currency: c.currency })}
                </span>
                <span className="w-40 shrink-0 truncate text-[0.82rem] text-muted-foreground">
                  {c.problem === "sin_asignar" ? "quedó en" : "salió de"} {c.account_name}
                </span>
              </div>
            ))}
          </div>
          {caidas.data!.items.length > 12 && (
            <p className="text-[0.82rem] text-faint-foreground">
              Y {caidas.data!.items.length - 12} más.
            </p>
          )}
        </section>
      )}

      {puedeDinero && cierres.isError && (
        <ErrorDeBloque
          titulo="No se pudieron cargar los cierres de caja"
          error={cierres.error}
          onReintentar={() => void cierres.refetch()}
        />
      )}
      {(cierres.data?.items ?? []).length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[1.05rem] font-semibold">Últimos cierres de caja</h2>
          <div className="divide-y divide-border rounded-md border border-border bg-surface">
            {(cierres.data?.items ?? []).slice(0, 5).map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-3 py-2 text-[0.9rem]">
                <span className="text-muted-foreground">{fechaLocal(c.closing_date)}</span>
                <span className="flex-1 truncate">
                  {lista.find((x) => x.id === c.account_id)?.name ?? "Cuenta"}
                </span>
                <ResultadoCierre cierre={c} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * J-02: una caja que estaba en NEGATIVO no tuvo un «sobrante»: lo que faltaba lo puso el dueño.
 * Las dos cifras llegan del servidor (`owner_contribution` y lo contado); aquí no se resta nada.
 */
function textoSobregiroCubierto(c: {
  owner_contribution: string;
  counted_amount: string;
  currency: string;
}): string {
  const delDueno = mostrarImporte({ amount: c.owner_contribution, currency: c.currency });
  const base = `Esta caja estaba en negativo. Lo que faltaba, ${delDueno}, queda anotado como dinero que puso el dueño.`;
  if (compararImportes(c.counted_amount, "0") <= 0) return base;
  const contado = mostrarImporte({ amount: c.counted_amount, currency: c.currency });
  return `${base} Lo que contaste, ${contado}, queda como sobrante.`;
}

function ResultadoCierre({ cierre }: { cierre: Cierre }): React.JSX.Element {
  if (cierre.owner_contribution != null)
    return (
      <span className="text-[0.85rem] text-muted-foreground">
        {textoSobregiroCubierto({ ...cierre, owner_contribution: cierre.owner_contribution })}
      </span>
    );
  const cmp = compararImportes(cierre.difference, "0");
  if (cmp === 0)
    return <span className="text-[0.85rem] text-success-soft-foreground">Cuadró exacta</span>;
  const importe = mostrarImporte({
    amount: cierre.difference.replace("-", ""),
    currency: cierre.currency,
  });
  return cmp > 0 ? (
    <span className="text-[0.85rem] text-success-soft-foreground">Sobraron {importe}</span>
  ) : (
    <span className="text-[0.85rem] text-destructive-soft-foreground">Faltaron {importe}</span>
  );
}

/**
 * La cifra de una tarjeta de deuda, o por qué no la hay. Con la tasa: el importe y la nota de que
 * es un cálculo a la tasa de hoy, no el saldo del mayor (J-04, ADR-0075 §6). Sin la tasa: se dice,
 * con lo que sí se conoce —el nominal por moneda—, nunca «0», «…» eterno ni la tarjeta escondida.
 */
function TotalDeDeuda({
  estado,
  importe,
  moneda,
  porMoneda,
  nota,
}: {
  estado: "cargando" | "cifra" | "sin_tasa";
  importe: string | null;
  moneda: string;
  porMoneda: NominalDeMoneda[] | undefined;
  nota: string;
}): React.JSX.Element {
  if (estado === "sin_tasa") {
    const nominal = nominalPorMoneda(porMoneda);
    return (
      <>
        <p className="mt-1 text-[1.05rem] font-semibold text-warning-soft-foreground">
          {FALTA_LA_TASA}
        </p>
        <p className="text-[0.8rem] text-muted-foreground">
          {nominal === ""
            ? "Tráela arriba para ver esta cifra en bolívares."
            : `Lo que se conoce, sin convertir: ${nominal}. Tráela arriba para verlo en bolívares.`}
        </p>
      </>
    );
  }
  return (
    <>
      <p className="mt-1 text-2xl font-semibold tabular-nums">
        {estado === "cifra" && importe !== null
          ? mostrarImporte({ amount: importe, currency: moneda })
          : "…"}
      </p>
      <p className="text-[0.8rem] text-muted-foreground">{nota}</p>
    </>
  );
}

function TarjetaTasa({
  tasa,
  error,
  onReintentar,
  onCambio,
}: {
  /** undefined = todavía sin respuesta; null = el servidor dijo que no hay tasa cargada. */
  tasa: TasaDelDia | null | undefined;
  /** La lectura falló (sin acceso, sin red): no es «no hay tasa», y no se dice como tal (N-05). */
  error: unknown;
  onReintentar: () => void;
  onCambio: () => void;
}): React.JSX.Element {
  const { llamar } = useSesion();
  const toast = useToast();

  // Solo existe la tasa del BCV (ADR-0064 §1): se actualiza sola y este botón la pide ya. No se
  // escribe a mano ni se «confirma»: un día sin publicación rige la última tasa del BCV.
  const traerBcv = useMutation({
    mutationFn: () =>
      llamar<{ rate: string }>("/v1/exchange-rates/bcv", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    onSuccess: (r) => {
      toast.success("Tasa BCV actualizada", tasaLimpia(r.rate));
      onCambio();
    },
    onError: (e) => toast.error("No se pudo traer la tasa", errorDePersona(e)),
  });

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-3 py-4">
        <div className="min-w-[12rem] flex-1">
          <div className="flex items-center gap-2 text-muted-foreground">
            <RefreshCw className="size-4" />
            <span className="text-[0.9rem]">Tasa BCV</span>
          </div>
          {error !== null && tasa === undefined ? (
            <div className="mt-1" role="alert">
              <p className="text-[0.95rem]">No se pudo leer la tasa.</p>
              <p className="text-[0.8rem] text-muted-foreground">{errorDePersona(error)}</p>
              <button
                type="button"
                onClick={onReintentar}
                className="text-[0.85rem] text-accent-soft-foreground hover:underline"
              >
                Reintentar
              </button>
            </div>
          ) : tasa === undefined ? (
            <p className="mt-1 text-2xl font-semibold tabular-nums">…</p>
          ) : tasa === null ? (
            <p className="mt-1 text-[0.95rem]">
              Todavía no hay tasa BCV. Tráela para poder vender en dólares.
            </p>
          ) : (
            <>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                Bs. {mostrarTasa(tasa.rate)}{" "}
                <span className="text-base font-normal text-muted-foreground">por dólar</span>
              </p>
              <p className="text-[0.8rem] text-faint-foreground">
                {tasa.es_de_hoy
                  ? "De hoy"
                  : `La última publicada, del ${fechaLocal(tasa.rate_date)}`}
              </p>
            </>
          )}
        </div>
        <Button
          variant={tasa === null || tasa?.es_de_hoy === false ? "primary" : "secondary"}
          disabled={traerBcv.isPending}
          onClick={() => traerBcv.mutate()}
        >
          {traerBcv.isPending ? "Consultando…" : "Traer del BCV"}
        </Button>
      </CardContent>
    </Card>
  );
}

function TarjetaCuenta({
  cuenta,
  cuentas,
  onCerrada,
  cierrePedido,
}: {
  cuenta: Cuenta;
  cuentas: Cuenta[];
  onCerrada: () => void;
  /** P-06: distinto de 0 cuando la paleta pidió cerrar ESTA caja; cada vez, un número nuevo. */
  cierrePedido: number;
}): React.JSX.Element {
  const { puede } = useSesion();
  const puedeCerrar = puede("cash.close");
  const puedeEditar = puede("treasury.account.manage");
  const [editando, setEditando] = useState(false);
  const [moviendo, setMoviendo] = useState(false);
  // Mover exige `treasury.reassign` (ADR-0062 §3) y que haya otra cuenta ACTIVA de la
  // misma moneda a donde llevarlo: un traslado no cambia de moneda.
  const destinos = cuentas.filter(
    (c) => c.id !== cuenta.id && c.is_active && !c.is_system && c.currency === cuenta.currency,
  );
  const puedeMover = puede("treasury.reassign") && destinos.length > 0;
  const Icono = ICONO_CUENTA[cuenta.kind];
  return (
    <Card className={cuenta.is_system ? "border-dashed" : undefined}>
      <CardContent className="py-4">
        <div className="flex items-center gap-2">
          <Icono className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium">{cuenta.name}</span>
          {cuenta.is_system && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[0.72rem] text-warning-soft-foreground">
              <Lock className="size-3" /> Por repartir
            </span>
          )}
        </div>
        <p className="mt-2 text-xl font-semibold tabular-nums">
          {mostrarImporte({ amount: cuenta.balance, currency: cuenta.currency })}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {cuenta.kind === "cash" && !cuenta.is_system && puedeCerrar && (
            <CerrarCaja cuenta={cuenta} onCerrada={onCerrada} pedido={cierrePedido} />
          )}
          {puedeMover && (
            <Button
              variant={cuenta.is_system ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setMoviendo(true)}
            >
              <ArrowLeftRight /> {cuenta.is_system ? "Repartir" : "Mover plata"}
            </Button>
          )}
          {!cuenta.is_system && puedeEditar && (
            <Button variant="ghost" size="sm" onClick={() => setEditando(true)}>
              Editar
            </Button>
          )}
        </div>
      </CardContent>
      {moviendo && (
        <MoverPlata
          key={`${cuenta.id}:${cuenta.balance}`}
          origen={cuenta}
          destinos={destinos}
          onCerrar={(hecho) => {
            setMoviendo(false);
            if (hecho) onCerrada();
          }}
        />
      )}
      {editando && (
        <EditarCuenta
          // El diálogo copia nombre y estado al montarse: si la cuenta cambia
          // debajo (refetch), la clave lo remonta con los datos nuevos.
          key={`${cuenta.id}:${cuenta.name}:${String(cuenta.is_active)}`}
          cuenta={cuenta}
          onCerrar={(hecho) => {
            setEditando(false);
            if (hecho) onCerrada();
          }}
        />
      )}
    </Card>
  );
}

/**
 * MOVER PLATA de una cuenta a otra (ADR-0062 §3, migración 61). Lo que entró a «Sin asignar»
 * porque se cobró con una forma sin cuenta se reparte aquí; y el efectivo que se llevó al
 * banco se registra igual. El traslado NO cambia de moneda: los destinos ya vienen filtrados.
 * Ningún número se calcula en la pantalla: el servidor escribe la salida, la entrada y lo que
 * corresponda en los libros.
 */
function MoverPlata({
  origen,
  destinos,
  onCerrar,
}: {
  origen: Cuenta;
  destinos: Cuenta[];
  onCerrar: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [destino, setDestino] = useState<string | null>(destinos[0]?.id ?? null);
  const [monto, setMonto] = useState("");
  const [motivo, setMotivo] = useState("");
  // Sobregiro: el servidor rechaza el egreso sin saldo con el número delante, y aquí se
  // pregunta antes de reenviar con la confirmación (ADR-0062 §4).
  const [sinSaldo, setSinSaldo] = useState<string | null>(null);

  const limpio = importeLimpio(monto);
  const montoOk = importeValido(limpio) && compararImportes(limpio, "0") > 0;
  const listo = montoOk && destino !== null && motivo.trim().length >= 3;

  const mover = useMutation({
    mutationFn: (forzar: string | null) =>
      llamar<{ amount: string; currency: string; accounting: "posted" | "queued" }>(
        "/v1/treasury/transfers",
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            company_id: empresa.id,
            from_account_id: origen.id,
            to_account_id: destino,
            amount: limpio,
            reason: motivo.trim(),
            ...(forzar !== null ? { allow_negative_balance: true, overdraft_reason: forzar } : {}),
          }),
        },
      ),
    onSuccess: (r) => {
      // Lo que el servidor registró, no lo que se tecleó. Cada cuenta tiene su subcuenta en los
      // libros (ADR-0070): el traslado se ve también en el mayor, o espera en la cola del contador.
      const hacia = destinos.find((d) => d.id === destino)?.name ?? "la otra cuenta";
      const libros =
        r.accounting === "posted"
          ? "Ya está en los libros."
          : "Los libros lo registran cuando el contador termine de configurarlos.";
      toast.success(
        "Plata movida",
        `${mostrarImporte({ amount: r.amount, currency: r.currency })} salieron de ${origen.name} y entraron a ${hacia}. ${libros}`,
      );
      onCerrar(true);
    },
    onError: (e) => {
      const falta = esSinSaldo(e);
      if (falta !== null) {
        setSinSaldo(falta);
        return;
      }
      toast.error("No se pudo mover", errorDePersona(e));
    },
  });

  return (
    <>
      <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
        <DialogContent>
          <DialogTitle>Mover plata desde {origen.name}</DialogTitle>
          <DialogDescription>
            Hoy hay{" "}
            <strong className="tabular-nums">
              {mostrarImporte({ amount: origen.balance, currency: origen.currency })}
            </strong>
            . Esto no gasta ni cobra nada: la misma plata cambia de sitio.
          </DialogDescription>
          <div className="space-y-3 pt-2">
            <FormField label="¿A qué cuenta va?" required>
              {(p) => (
                <SimpleSelect
                  id={p.id}
                  value={destino}
                  onValueChange={setDestino}
                  options={destinos.map((d) => ({
                    value: d.id,
                    label: `${d.name} (${mostrarImporte({ amount: d.balance, currency: d.currency })})`,
                  }))}
                />
              )}
            </FormField>
            <FormField label={`¿Cuánto (${origen.currency})?`} required>
              {(p) => (
                <MoneyInput {...p} value={monto} onChange={setMonto} currency={origen.currency} />
              )}
            </FormField>
            <FormField label="¿Por qué?" required hint="Queda escrito en el historial del negocio.">
              {(p) => (
                <Input
                  {...p}
                  value={motivo}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMotivo(e.target.value)}
                  placeholder="Reparto de lo cobrado hoy"
                />
              )}
            </FormField>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onCerrar(false)}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              disabled={!listo || mover.isPending}
              onClick={() => mover.mutate(null)}
            >
              Mover
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {sinSaldo !== null && (
        <ConfirmarSobregiro
          mensaje={sinSaldo}
          onCancelar={() => setSinSaldo(null)}
          onConfirmar={async (porQue) => {
            await mover.mutateAsync(porQue);
            setSinSaldo(null);
          }}
        />
      )}
    </>
  );
}

/**
 * EDITAR/APAGAR una cuenta (Nivel B de la auditoría): se creaban y no se
 * corregían. La moneda y el tipo no se tocan — una cuenta con historia no
 * cambia de moneda; se apaga y se crea otra.
 */
function EditarCuenta({
  cuenta,
  onCerrar,
}: {
  cuenta: Cuenta;
  onCerrar: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [nombre, setNombre] = useState(cuenta.name);
  const [activa, setActiva] = useState(cuenta.is_active);

  const guardar = useMutation({
    mutationFn: () =>
      llamar("/v1/treasury/accounts/" + cuenta.id, {
        method: "PATCH",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          name: nombre.trim(),
          is_active: activa,
        }),
      }),
    onSuccess: () => {
      toast.success("Cuenta actualizada");
      onCerrar(true);
    },
    onError: (e) => toast.error("No se pudo actualizar", errorDePersona(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-sm">
        <DialogTitle>Editar {cuenta.name}</DialogTitle>
        <DialogDescription>
          La moneda no se cambia: una cuenta con historia no se reinterpreta. Si sobra, apágala.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <FormField label="Nombre" required>
            {(a) => (
              <Input
                {...a}
                value={nombre}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNombre(e.target.value)}
              />
            )}
          </FormField>
          <label className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
            <span className="text-[0.9rem]">
              Cuenta activa
              <span className="block text-[0.78rem] text-muted-foreground">
                Apagada no recibe cobros ni paga gastos; su historia queda intacta.
              </span>
            </span>
            <Switch checked={activa} onCheckedChange={setActiva} aria-label="Cuenta activa" />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onCerrar(false)}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={nombre.trim() === "" || guardar.isPending}
            onClick={() => guardar.mutate()}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CerrarCaja({
  cuenta,
  onCerrada,
  pedido,
}: {
  cuenta: Cuenta;
  onCerrada: () => void;
  pedido: number;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [abierto, setAbierto] = useState(false);
  const [contado, setContado] = useState("");
  const [motivo, setMotivo] = useState("");
  // P-06: la paleta abre el mismo diálogo que el botón; nada se cierra sin contar y confirmar.
  useEffect(() => {
    if (pedido > 0) setAbierto(true);
  }, [pedido]);

  const contadoLimpio = importeLimpio(contado);
  const contadoOk = importeValido(contadoLimpio);
  // Comparación de STRINGS decimales (decimal-compare.ts): decide si pedir el
  // motivo, nada más. El importe de la diferencia lo calcula el servidor.
  const difiere = contadoOk && compararImportes(contadoLimpio, cuenta.balance) !== 0;
  const listo = contadoOk && (!difiere || motivo.trim().length >= 3);

  const cerrar = useMutation({
    mutationFn: () =>
      llamar<{
        difference: string;
        currency: string;
        accounting: string;
        counted_amount: string;
        owner_contribution: string | null;
      }>("/v1/cash-closings", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          account_id: cuenta.id,
          counted_amount: contadoLimpio,
          ...(difiere ? { reason: motivo.trim() } : {}),
        }),
      }),
    onSuccess: (r) => {
      const cmp = compararImportes(r.difference, "0");
      const importe = mostrarImporte({
        amount: r.difference.replace("-", ""),
        currency: r.currency,
      });
      toast.success(
        "Caja cerrada",
        r.owner_contribution != null
          ? textoSobregiroCubierto({ ...r, owner_contribution: r.owner_contribution })
          : cmp === 0
            ? "Cuadró exacta."
            : cmp > 0
              ? `Sobraron ${importe}.`
              : `Faltaron ${importe}.`,
      );
      setAbierto(false);
      setContado("");
      setMotivo("");
      onCerrada();
    },
    onError: (e) => toast.error("No se pudo cerrar la caja", errorDePersona(e)),
  });

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setAbierto(true)}>
        Cerrar la caja
      </Button>
      {abierto && (
        <Dialog open onOpenChange={(v) => !v && setAbierto(false)}>
          <DialogContent>
            <DialogTitle>Cerrar {cuenta.name}</DialogTitle>
            <DialogDescription>
              Según lo registrado, debería haber{" "}
              <strong className="tabular-nums">
                {mostrarImporte({ amount: cuenta.balance, currency: cuenta.currency })}
              </strong>
              . Cuenta lo que hay de verdad y escríbelo aquí: si no coincide, quedará anotado con tu
              motivo y la cuenta arranca mañana con lo contado.
            </DialogDescription>
            <div className="space-y-3 pt-2">
              <FormField label="Lo que conté" required>
                {(p) => (
                  <MoneyInput
                    {...p}
                    value={contado}
                    onChange={setContado}
                    currency={cuenta.currency}
                  />
                )}
              </FormField>
              {difiere && (
                <FormField
                  label="¿De dónde sale la diferencia?"
                  required
                  hint="Una línea basta: «pagué el flete de la caja», «un billete falso», «vuelto de ayer»."
                >
                  {(p) => (
                    <Input {...p} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
                  )}
                </FormField>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setAbierto(false)}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                disabled={!listo || cerrar.isPending}
                onClick={() => cerrar.mutate()}
              >
                Cerrar caja
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export function CrearCuenta({ onCreada }: { onCreada: () => void }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [abierto, setAbierto] = useState(false);
  const [nombre, setNombre] = useState("");
  const [moneda, setMoneda] = useState<string | null>("VES");
  const [tipo, setTipo] = useState<string | null>("cash");

  const crear = useMutation({
    mutationFn: () =>
      llamar("/v1/treasury/accounts", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          name: nombre.trim(),
          currency: moneda,
          kind: tipo,
        }),
      }),
    onSuccess: () => {
      toast.success("Cuenta creada");
      setAbierto(false);
      setNombre("");
      onCreada();
    },
    onError: (e) => toast.error("No se pudo crear la cuenta", errorDePersona(e)),
  });

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setAbierto(true)}>
        <Plus /> Agregar cuenta
      </Button>
      {abierto && (
        <Dialog open onOpenChange={(v) => !v && setAbierto(false)}>
          <DialogContent>
            <DialogTitle>Nueva cuenta</DialogTitle>
            <DialogDescription>
              Dale el nombre con el que la conoces: «Caja del local», «Banesco», «Zelle de Ana».
            </DialogDescription>
            <div className="space-y-3 pt-2">
              <FormField label="Nombre" required>
                {(p) => <Input {...p} value={nombre} onChange={(e) => setNombre(e.target.value)} />}
              </FormField>
              <FormField
                label="Moneda"
                required
                hint="La moneda no se cambia después: la plata que entra aquí vive en ella."
              >
                {(p) => (
                  <SimpleSelect
                    id={p.id}
                    value={moneda}
                    onValueChange={setMoneda}
                    options={MONEDAS}
                  />
                )}
              </FormField>
              <FormField label="Tipo" required>
                {(p) => (
                  <SimpleSelect
                    id={p.id}
                    value={tipo}
                    onValueChange={setTipo}
                    options={TIPOS_CUENTA}
                  />
                )}
              </FormField>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setAbierto(false)}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                disabled={nombre.trim().length < 2 || crear.isPending}
                onClick={() => crear.mutate()}
              >
                Crear cuenta
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function CrearFormaDePago({
  cuentas,
  onCreada,
}: {
  cuentas: Cuenta[];
  onCreada: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [abierto, setAbierto] = useState(false);
  const [nombre, setNombre] = useState("");
  const [tipo, setTipo] = useState<string | null>(null);
  const [cuenta, setCuenta] = useState<string | null>(null);

  const activas = cuentas.filter((c) => c.is_active && !c.is_system);
  // Elegido el tipo, la lista se reduce a las cuentas donde ese dinero PUEDE entrar: un
  // «Zelle» no entra a una caja en bolívares. Sin tipo elegido, se ven todas.
  const exigida = tipo === null ? null : (MONEDA_DE_FORMA[tipo] ?? null);
  const compatibles =
    exigida === null
      ? activas
      : activas.filter((c) => (exigida === "USD" ? c.currency === "USD" : c.currency !== "USD"));

  const crear = useMutation({
    mutationFn: () =>
      llamar("/v1/payment-methods", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          name: nombre.trim(),
          kind: tipo,
          account_id: cuenta,
        }),
      }),
    onSuccess: () => {
      toast.success("Forma de pago lista");
      setAbierto(false);
      setNombre("");
      setTipo(null);
      setCuenta(null);
      onCreada();
    },
    onError: (e) => toast.error("No se pudo crear la forma de pago", errorDePersona(e)),
  });

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setAbierto(true)}
        disabled={activas.length === 0}
      >
        <Plus /> Agregar forma
      </Button>
      {abierto && (
        <Dialog open onOpenChange={(v) => !v && setAbierto(false)}>
          <DialogContent>
            <DialogTitle>Nueva forma de pago</DialogTitle>
            <DialogDescription>
              «Pago móvil → Banesco»: cuando cobres con esta forma, la plata entra a esa cuenta.
            </DialogDescription>
            <div className="space-y-3 pt-2">
              <FormField label="Nombre" required>
                {(p) => (
                  <Input
                    {...p}
                    value={nombre}
                    onChange={(e) => setNombre(e.target.value)}
                    placeholder="Pago móvil Banesco"
                  />
                )}
              </FormField>
              <FormField label="Tipo" required>
                {(p) => (
                  <SimpleSelect
                    id={p.id}
                    value={tipo}
                    onValueChange={(v) => {
                      setTipo(v);
                      setCuenta(null);
                    }}
                    options={FORMAS}
                  />
                )}
              </FormField>
              <FormField
                label="A qué cuenta entra"
                required
                {...(exigida !== null && compatibles.length === 0
                  ? {
                      hint: `No hay ninguna cuenta en ${exigida === "USD" ? "dólares" : "bolívares"}: crea una arriba y vuelve.`,
                    }
                  : {})}
              >
                {(p) => (
                  <SimpleSelect
                    id={p.id}
                    value={cuenta}
                    onValueChange={setCuenta}
                    options={compatibles.map((c) => ({
                      value: c.id,
                      label: `${c.name} (${c.currency})`,
                    }))}
                  />
                )}
              </FormField>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setAbierto(false)}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                disabled={
                  nombre.trim().length < 2 || tipo === null || cuenta === null || crear.isPending
                }
                onClick={() => crear.mutate()}
              >
                Crear
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/** El chip de forma de pago, ahora con su edición (renombrar / apagar). */
function FormaDePagoChip({
  forma,
  cuentaNombre,
  onCambio,
}: {
  forma: FormaDePago;
  cuentaNombre: string;
  onCambio: () => void;
}): React.JSX.Element {
  const [editando, setEditando] = useState(false);

  return (
    <>
      <button
        className={
          "inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[0.85rem] hover:border-accent " +
          (forma.is_active ? "" : "opacity-50")
        }
        onClick={() => setEditando(true)}
        aria-label={"Editar la forma de pago " + forma.name}
      >
        <CreditCard className="size-3.5 text-muted-foreground" />
        {forma.name}
        <span className="text-faint-foreground">→ {cuentaNombre}</span>
        {!forma.is_active && <span className="text-faint-foreground">(apagada)</span>}
      </button>
      {editando && (
        <EditarFormaDePago
          // El formulario copia el prop al montarse: la clave lo remonta si
          // la forma cambia debajo (auditoría 2026-09-11).
          key={`${forma.id}:${forma.name}:${String(forma.is_active)}`}
          forma={forma}
          onCerrar={(hecho) => {
            setEditando(false);
            if (hecho) onCambio();
          }}
        />
      )}
    </>
  );
}

function EditarFormaDePago({
  forma,
  onCerrar,
}: {
  forma: FormaDePago;
  onCerrar: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [nombre, setNombre] = useState(forma.name);
  const [activa, setActiva] = useState(forma.is_active);

  const guardar = useMutation({
    mutationFn: () =>
      llamar("/v1/payment-methods/" + forma.id, {
        method: "PATCH",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          name: nombre.trim(),
          is_active: activa,
        }),
      }),
    onSuccess: () => {
      toast.success("Forma de pago actualizada");
      onCerrar(true);
    },
    onError: (e) => toast.error("No se pudo actualizar", errorDePersona(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-sm">
        <DialogTitle>Editar {forma.name}</DialogTitle>
        <div className="space-y-3 pt-2">
          <FormField label="Nombre" required>
            {(a) => (
              <Input
                {...a}
                value={nombre}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNombre(e.target.value)}
              />
            )}
          </FormField>
          <label className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
            <span className="text-[0.9rem]">Activa en el punto de venta</span>
            <Switch checked={activa} onCheckedChange={setActiva} aria-label="Forma activa" />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onCerrar(false)}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={nombre.trim() === "" || guardar.isPending}
            onClick={() => guardar.mutate()}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
