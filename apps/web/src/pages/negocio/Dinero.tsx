import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  CreditCard,
  Landmark,
  Lock,
  Plus,
  RefreshCw,
  Smartphone,
  Wallet,
} from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona } from "../../lib.js";
import { mostrarImporte, mostrarCantidad } from "../../money.js";
import { compararImportes } from "../../components/decimal-compare.js";
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
import { useToast } from "../../ui/toast.js";
import { FormField, MoneyInput, importeValido } from "../../components/forms.js";

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
interface Resumen {
  functional_currency: string;
  lo_que_me_deben: string;
  lo_que_debo: string;
  tasa_del_dia: { rate: string; rate_date: string; source: string; es_de_hoy: boolean } | null;
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
  reason: string | null;
  currency: string;
}

const ICONO_CUENTA = { cash: Banknote, bank: Landmark, wallet: Smartphone } as const;

const TIPOS_CUENTA = [
  { value: "cash", label: "Caja (efectivo)" },
  { value: "bank", label: "Banco" },
  { value: "wallet", label: "Billetera digital (Zelle, USDT…)" },
];
const MONEDAS = [
  { value: "VES", label: "Bolívares (Bs.)" },
  { value: "USD", label: "Dólares (USD)" },
];
const FORMAS = [
  { value: "efectivo_bs", label: "Efectivo en bolívares" },
  { value: "efectivo_usd", label: "Efectivo en dólares" },
  { value: "pago_movil", label: "Pago móvil" },
  { value: "transferencia", label: "Transferencia" },
  { value: "punto_venta", label: "Punto de venta" },
  { value: "tarjeta", label: "Tarjeta" },
  { value: "zelle", label: "Zelle" },
  { value: "usdt", label: "USDT" },
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
  const cuentas = useQuery({
    queryKey: ["cuentas", empresa.id],
    queryFn: () => llamar<{ accounts: Cuenta[] }>("/v1/treasury/accounts"),
  });
  const formas = useQuery({
    queryKey: ["formas-pago", empresa.id],
    queryFn: () => llamar<{ methods: FormaDePago[] }>("/v1/payment-methods"),
  });
  const cierres = useQuery({
    queryKey: ["cierres", empresa.id],
    enabled: puedeDinero,
    queryFn: () => llamar<{ items: Cierre[] }>("/v1/cash-closings"),
  });

  const recargar = () => {
    void qc.invalidateQueries({ queryKey: ["negocio-resumen", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["cuentas", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["cierres", empresa.id] });
  };

  const lista = cuentas.data?.accounts ?? [];
  const funcional = resumen.data?.functional_currency ?? "VES";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h1 className="text-xl font-semibold">Mi dinero</h1>

      <TarjetaTasa resumen={resumen.data ?? null} onCambio={recargar} />

      {puedeDinero && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center gap-2 text-muted-foreground">
                <ArrowDownToLine className="size-4" />
                <span className="text-[0.9rem]">Lo que me deben</span>
              </div>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {resumen.data
                  ? mostrarImporte({ amount: resumen.data.lo_que_me_deben, currency: funcional })
                  : "…"}
              </p>
              <Link
                to="/clientes"
                className="text-[0.85rem] text-accent-soft-foreground hover:underline"
              >
                Ver quién me debe
              </Link>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center gap-2 text-muted-foreground">
                <ArrowUpFromLine className="size-4" />
                <span className="text-[0.9rem]">Lo que debo</span>
              </div>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {resumen.data
                  ? mostrarImporte({ amount: resumen.data.lo_que_debo, currency: funcional })
                  : "…"}
              </p>
              <Link
                to="/compras"
                className="text-[0.85rem] text-accent-soft-foreground hover:underline"
              >
                Ver qué debo
              </Link>
            </CardContent>
          </Card>
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
              <TarjetaCuenta key={c.id} cuenta={c} onCerrada={recargar} />
            ))}
          </div>
        )}
      </section>

      {puedeDinero && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[1.05rem] font-semibold">Formas de pago</h2>
            <CrearFormaDePago
              cuentas={lista}
              onCreada={() => void qc.invalidateQueries({ queryKey: ["formas-pago", empresa.id] })}
            />
          </div>
          <p className="text-[0.85rem] text-muted-foreground">
            Cada forma apunta a una cuenta: cuando cobras con ella, la plata entra ahí sola.
          </p>
          {(formas.data?.methods ?? []).length === 0 ? (
            <p className="text-[0.9rem] text-faint-foreground">
              Sin formas configuradas, los cobros van a «Sin asignar» y luego hay que repartirlos.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {(formas.data?.methods ?? []).map((f) => {
                const cuenta = lista.find((c) => c.id === f.account_id);
                return (
                  <span
                    key={f.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[0.85rem]"
                  >
                    <CreditCard className="size-3.5 text-muted-foreground" />
                    {f.name}
                    <span className="text-faint-foreground">→ {cuenta?.name ?? "?"}</span>
                  </span>
                );
              })}
            </div>
          )}
        </section>
      )}

      {(cierres.data?.items ?? []).length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[1.05rem] font-semibold">Últimos cierres de caja</h2>
          <div className="divide-y divide-border rounded-md border border-border bg-surface">
            {(cierres.data?.items ?? []).slice(0, 5).map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-3 py-2 text-[0.9rem]">
                <span className="text-muted-foreground">{c.closing_date}</span>
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

function ResultadoCierre({ cierre }: { cierre: Cierre }): React.JSX.Element {
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

function TarjetaTasa({
  resumen,
  onCambio,
}: {
  resumen: Resumen | null;
  onCambio: () => void;
}): React.JSX.Element {
  const { llamar } = useSesion();
  const toast = useToast();
  const [editando, setEditando] = useState(false);
  const [nueva, setNueva] = useState("");

  const confirmar = useMutation({
    mutationFn: () =>
      llamar("/v1/exchange-rates/keep", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ from_currency: "USD", to_currency: "VES" }),
      }),
    onSuccess: () => {
      toast.success("Tasa confirmada para hoy");
      onCambio();
    },
    onError: (e) => toast.error("No se pudo confirmar la tasa", errorDePersona(e)),
  });

  // La tasa OFICIAL, traída del BCV (vía DolarAPI) y guardada con su fuente.
  // Si no hay internet, el camino manual de abajo sigue ahí.
  const traerBcv = useMutation({
    mutationFn: () =>
      llamar<{ rate: string }>("/v1/exchange-rates/bcv", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    onSuccess: (r) => {
      toast.success("Tasa del BCV traída", `Bs. ${mostrarCantidad(r.rate)} por dólar`);
      onCambio();
    },
    onError: (e) => toast.error("No se pudo traer la tasa", errorDePersona(e)),
  });

  const cambiar = useMutation({
    mutationFn: () =>
      llamar("/v1/exchange-rates", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          from_currency: "USD",
          to_currency: "VES",
          rate: nueva.trim().replace(",", "."),
          source: "Carga manual del negocio",
          // El día LOCAL de la persona, no el de UTC: a las 9 pm de Caracas,
          // toISOString ya va por mañana (la familia de bugs de CLAUDE.md §3).
          rate_date: new Date().toLocaleDateString("en-CA"),
        }),
      }),
    onSuccess: () => {
      toast.success("Tasa del día guardada");
      setEditando(false);
      setNueva("");
      onCambio();
    },
    onError: (e) => toast.error("No se pudo guardar la tasa", errorDePersona(e)),
  });

  const tasa = resumen?.tasa_del_dia ?? null;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-4 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-muted-foreground">
            <RefreshCw className="size-4" />
            <span className="text-[0.9rem]">Tasa del día</span>
          </div>
          {tasa === null ? (
            <p className="mt-1 text-[0.95rem]">
              Todavía no hay tasa cargada. Ponla para poder vender en dólares.
            </p>
          ) : (
            <>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                Bs. {mostrarCantidad(tasa.rate)}{" "}
                <span className="text-base font-normal text-muted-foreground">por dólar</span>
              </p>
              <p className="text-[0.8rem] text-faint-foreground">
                {tasa.es_de_hoy ? "Confirmada hoy" : `Del ${tasa.rate_date}`} · {tasa.source}
              </p>
            </>
          )}
        </div>
        {!editando ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={tasa === null || !tasa.es_de_hoy ? "primary" : "secondary"}
              disabled={traerBcv.isPending}
              onClick={() => traerBcv.mutate()}
            >
              {traerBcv.isPending ? "Consultando…" : "Traer del BCV"}
            </Button>
            {tasa !== null && !tasa.es_de_hoy && (
              <Button
                variant="secondary"
                disabled={confirmar.isPending}
                onClick={() => confirmar.mutate()}
              >
                Sigue igual
              </Button>
            )}
            <Button variant="secondary" onClick={() => setEditando(true)}>
              {tasa === null ? "Cargarla a mano" : "Cambió"}
            </Button>
          </div>
        ) : (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (importeValido(nueva.trim().replace(",", "."))) cambiar.mutate();
            }}
          >
            <FormField label="Bs. por dólar" required>
              {(p) => (
                <MoneyInput
                  {...p}
                  value={nueva}
                  onChange={setNueva}
                  currency="Bs."
                  className="w-36"
                />
              )}
            </FormField>
            <Button
              type="submit"
              variant="primary"
              disabled={cambiar.isPending || !importeValido(nueva.trim().replace(",", "."))}
            >
              Guardar
            </Button>
            <Button variant="ghost" onClick={() => setEditando(false)}>
              Cancelar
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function TarjetaCuenta({
  cuenta,
  onCerrada,
}: {
  cuenta: Cuenta;
  onCerrada: () => void;
}): React.JSX.Element {
  const { puede } = useSesion();
  const puedeCerrar = puede("cash.close");
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
        {cuenta.kind === "cash" && !cuenta.is_system && puedeCerrar && (
          <div className="mt-2">
            <CerrarCaja cuenta={cuenta} onCerrada={onCerrada} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CerrarCaja({
  cuenta,
  onCerrada,
}: {
  cuenta: Cuenta;
  onCerrada: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [abierto, setAbierto] = useState(false);
  const [contado, setContado] = useState("");
  const [motivo, setMotivo] = useState("");

  const contadoLimpio = contado.trim().replace(",", ".");
  const contadoOk = importeValido(contadoLimpio);
  // Comparación de STRINGS decimales (decimal-compare.ts): decide si pedir el
  // motivo, nada más. El importe de la diferencia lo calcula el servidor.
  const difiere = contadoOk && compararImportes(contadoLimpio, cuenta.balance) !== 0;
  const listo = contadoOk && (!difiere || motivo.trim().length >= 3);

  const cerrar = useMutation({
    mutationFn: () =>
      llamar<{ difference: string; currency: string; accounting: string }>("/v1/cash-closings", {
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
        cmp === 0 ? "Cuadró exacta." : cmp > 0 ? `Sobraron ${importe}.` : `Faltaron ${importe}.`,
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
                  <SimpleSelect id={p.id} value={tipo} onValueChange={setTipo} options={FORMAS} />
                )}
              </FormField>
              <FormField label="A qué cuenta entra" required>
                {(p) => (
                  <SimpleSelect
                    id={p.id}
                    value={cuenta}
                    onValueChange={setCuenta}
                    options={activas.map((c) => ({
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
