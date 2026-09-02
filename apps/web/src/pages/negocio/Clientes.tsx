import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Plus, Search, Users } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona } from "../../lib.js";
import { mostrarImporte } from "../../money.js";
import { compararImportes, esCero } from "../../components/decimal-compare.js";
import { Button } from "../../ui/button.js";
import { Card } from "../../ui/card.js";
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
import { fechaRelativa, formatearDocumento } from "./comunes.js";

/**
 * CLIENTES (Fase C, PARTE 9): a quién le vendo y quién me debe. La lista trae
 * la deuda de cada uno CALCULADA POR EL SERVIDOR; el alta rápida infiere el
 * tipo por el RIF (J/G = empresa, V/E o vacío = persona); la ficha enseña la
 * deuda en grande, cobra factura por factura (parcial vale) y arma el estado
 * de cuenta para WhatsApp.
 */

interface ClienteFila {
  id: string;
  legal_name: string;
  tax_id: string | null;
  phone: string | null;
  is_system?: boolean;
  debt?: string;
}
interface DocumentoAbierto {
  id: string;
  series: string;
  document_number: number | null;
  issued_at: string | null;
  total_amount: string;
  balance: string;
  status: string;
}
interface EstadoDeCuenta {
  currency: string;
  documents: DocumentoAbierto[];
  total_outstanding: string;
}
interface FormaDePago {
  id: string;
  name: string;
  kind: string;
  account_id: string;
  is_active: boolean;
}

function useDebounced<T>(valor: T, ms: number): T {
  const [v, setV] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setV(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return v;
}

export function ClientesNegocio(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [busqueda, setBusqueda] = useState("");
  const [alta, setAlta] = useState(false);
  const [ficha, setFicha] = useState<ClienteFila | null>(null);
  const qc = useQueryClient();
  const q = useDebounced(busqueda.trim(), 250);

  const clientes = useQuery({
    queryKey: ["negocio-clientes", empresa.id, q],
    queryFn: () =>
      llamar<{ items: ClienteFila[]; total: number }>(
        `/v1/customers?with_debt=1&per_page=100${q === "" ? "" : `&search=${encodeURIComponent(q)}`}`,
      ),
  });
  const recargar = () => void qc.invalidateQueries({ queryKey: ["negocio-clientes", empresa.id] });

  // El Consumidor final no se lista: es la contraparte del mostrador, no un
  // cliente que se gestione.
  const items = (clientes.data?.items ?? []).filter((c) => c.is_system !== true);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">Clientes</h1>
        <div className="flex-1" />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint-foreground" />
          <Input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Nombre o RIF…"
            className="w-56 pl-8"
            aria-label="Buscar clientes"
          />
        </div>
        <Button variant="primary" onClick={() => setAlta(true)}>
          <Plus /> Agregar cliente
        </Button>
      </div>

      {clientes.isLoading ? (
        <p className="text-muted-foreground">Cargando…</p>
      ) : items.length === 0 ? (
        <Card className="py-12 text-center">
          <Users className="mx-auto size-8 text-faint-foreground" />
          <p className="mt-2 font-medium">
            {q === "" ? "Todavía no tienes clientes registrados" : "Nadie con ese nombre"}
          </p>
          <p className="mx-auto mt-1 max-w-sm text-[0.9rem] text-muted-foreground">
            {q === ""
              ? "Para vender de mostrador no hace falta ninguno. Registra a los que compran fiado o piden factura con sus datos."
              : "Revisa cómo lo escribiste, o agrégalo si es nuevo."}
          </p>
          {q === "" && (
            <Button variant="primary" className="mt-4" onClick={() => setAlta(true)}>
              <Plus /> Agregar cliente
            </Button>
          )}
        </Card>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border bg-surface">
          {items.map((c) => (
            <button
              key={c.id}
              onClick={() => setFicha(c)}
              className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft font-medium text-accent-soft-foreground">
                {c.legal_name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{c.legal_name}</span>
                <span className="block text-[0.8rem] text-muted-foreground tabular-nums">
                  {c.tax_id !== null ? formatearDocumento(c.tax_id) : "Sin RIF"}
                  {c.phone !== null ? ` · ${c.phone}` : ""}
                </span>
              </span>
              <Deuda debt={c.debt} />
            </button>
          ))}
        </div>
      )}

      {alta && <AltaCliente onCerrar={() => setAlta(false)} onCreado={recargar} />}
      {ficha !== null && (
        <FichaCliente cliente={ficha} onCerrar={() => setFicha(null)} onCambio={recargar} />
      )}
    </div>
  );
}

function Deuda({ debt }: { debt: string | undefined }): React.JSX.Element {
  if (debt === undefined || esCero(debt)) {
    return <span className="text-[0.85rem] text-success-soft-foreground">Al día</span>;
  }
  return (
    <span className="text-[0.9rem] font-medium text-warning-soft-foreground tabular-nums">
      Me debe {mostrarImporte({ amount: debt, currency: "VES" })}
    </span>
  );
}

/** J/G → empresa; P → extranjera; V/E o sin RIF → persona. El contador afina en /admin. */
function inferirTipo(taxId: string): { persona: string; contribuyente: string } {
  const t = taxId.trim().toUpperCase();
  if (t.startsWith("J")) return { persona: "juridica", contribuyente: "ordinario" };
  if (t.startsWith("G")) return { persona: "gobierno", contribuyente: "ordinario" };
  if (t.startsWith("P")) return { persona: "extranjera", contribuyente: "no_domiciliado" };
  return { persona: "natural", contribuyente: "consumidor_final" };
}

function AltaCliente({
  onCerrar,
  onCreado,
}: {
  onCerrar: () => void;
  onCreado: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [nombre, setNombre] = useState("");
  const [rif, setRif] = useState("");
  const [telefono, setTelefono] = useState("");
  const [direccion, setDireccion] = useState("");

  // El documento viaja NORMALIZADO (prefijo + alfanumérico, sin separadores):
  // los guiones y puntos son presentación y los pone `formatearDocumento`.
  const documento = rif
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  const crear = useMutation({
    mutationFn: () => {
      const tipo = inferirTipo(documento);
      return llamar("/v1/customers", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          legal_name: nombre.trim(),
          ...(documento === "" ? {} : { tax_id: documento }),
          ...(telefono.trim() === "" ? {} : { phone: telefono.trim() }),
          ...(direccion.trim() === "" ? {} : { fiscal_address: direccion.trim() }),
          person_type_code: tipo.persona,
          taxpayer_type_code: tipo.contribuyente,
        }),
      });
    },
    onSuccess: () => {
      toast.success("Cliente agregado");
      onCreado();
      onCerrar();
    },
    onError: (e) => toast.error("No se pudo agregar", errorDePersona(e)),
  });

  const esEmpresa = /^[JG]/.test(documento);
  const listo =
    nombre.trim().length > 0 && (!esEmpresa || (documento.length >= 3 && direccion.trim() !== ""));

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-sm">
        <DialogTitle>Nuevo cliente</DialogTitle>
        <DialogDescription>
          Con el nombre basta. El RIF, si te lo pide en factura.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <FormField label="Nombre" required>
            {(p) => (
              <Input {...p} value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus />
            )}
          </FormField>
          <FormField
            label="RIF o cédula"
            hint={
              rif.trim() === ""
                ? "V-12345678 para persona, J-12345678-9 para empresa."
                : esEmpresa
                  ? "Con J o G queda registrado como empresa."
                  : "Queda registrado como persona."
            }
          >
            {(p) => <Input {...p} value={rif} onChange={(e) => setRif(e.target.value)} />}
          </FormField>
          <FormField label="Teléfono" hint="Para mandarle su estado de cuenta por WhatsApp.">
            {(p) => (
              <Input
                {...p}
                inputMode="tel"
                value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
                placeholder="0414-1234567"
              />
            )}
          </FormField>
          <FormField
            label="Dirección"
            {...(esEmpresa
              ? { required: true, hint: "Una factura a una empresa lleva su domicilio fiscal." }
              : {})}
          >
            {(p) => (
              <Input {...p} value={direccion} onChange={(e) => setDireccion(e.target.value)} />
            )}
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={!listo || crear.isPending}
            onClick={() => crear.mutate()}
          >
            Agregar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FichaCliente({
  cliente,
  onCerrar,
  onCambio,
}: {
  cliente: ClienteFila;
  onCerrar: () => void;
  onCambio: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [cobrando, setCobrando] = useState<DocumentoAbierto | null>(null);
  const qc = useQueryClient();

  const estado = useQuery({
    queryKey: ["estado-cliente", empresa.id, cliente.id],
    queryFn: () => llamar<EstadoDeCuenta>(`/v1/customers/${cliente.id}/statement`),
  });

  const abiertas = (estado.data?.documents ?? []).filter(
    (d) => d.status === "issued" && compararImportes(d.balance, "0") > 0,
  );

  const textoEstado = (): string => {
    if (!estado.data) return "";
    const filas = abiertas
      .map(
        (d) =>
          `• Factura ${d.series}-${String(d.document_number ?? "")}: ${mostrarImporte({ amount: d.balance, currency: estado.data.currency })}`,
      )
      .join("\n");
    return `Hola ${cliente.legal_name}, te escribe ${empresa.legal_name}. Tu cuenta pendiente:\n${filas}\nTotal: ${mostrarImporte({ amount: estado.data.total_outstanding, currency: estado.data.currency })}. ¡Gracias!`;
  };

  const telefonoWa = (cliente.phone ?? "").replace(/[^0-9]/g, "").replace(/^0/, "58");

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-md">
        <DialogTitle>{cliente.legal_name}</DialogTitle>
        <div className="space-y-4 pt-2">
          <div className="rounded-lg bg-surface-muted p-4 text-center">
            <p className="text-[0.85rem] text-muted-foreground">Me debe</p>
            <p className="text-3xl font-semibold tabular-nums">
              {estado.data
                ? mostrarImporte({
                    amount: estado.data.total_outstanding,
                    currency: estado.data.currency,
                  })
                : "…"}
            </p>
          </div>

          {abiertas.length > 0 && (
            <div>
              <p className="pb-1.5 text-[0.9rem] font-medium">Facturas pendientes</p>
              <div className="divide-y divide-border rounded-md border border-border">
                {abiertas.map((d) => (
                  <div key={d.id} className="flex items-center gap-2 px-3 py-2 text-[0.9rem]">
                    <span className="min-w-0 flex-1">
                      {d.series}-{String(d.document_number ?? "").padStart(6, "0")}
                      <span className="text-[0.8rem] text-muted-foreground">
                        {" "}
                        · {d.issued_at !== null ? fechaRelativa(d.issued_at) : ""}
                      </span>
                    </span>
                    <span className="tabular-nums">
                      {mostrarImporte({
                        amount: d.balance,
                        currency: estado.data?.currency ?? "VES",
                      })}
                    </span>
                    <Button variant="secondary" size="sm" onClick={() => setCobrando(d)}>
                      Cobrar
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-2">
            {abiertas.length > 0 &&
              (cliente.phone !== null ? (
                <a
                  href={`https://wa.me/${telefonoWa}?text=${encodeURIComponent(textoEstado())}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button variant="secondary" className="w-full">
                    <MessageCircle /> Mandar estado de cuenta por WhatsApp
                  </Button>
                </a>
              ) : (
                <p className="text-center text-[0.82rem] text-faint-foreground">
                  Ponle teléfono al cliente para mandarle su cuenta por WhatsApp.
                </p>
              ))}
          </div>
        </div>
        {cobrando !== null && estado.data && (
          <CobrarFactura
            documento={cobrando}
            moneda={estado.data.currency}
            onCerrar={() => setCobrando(null)}
            onCobrada={() => {
              setCobrando(null);
              void qc.invalidateQueries({ queryKey: ["estado-cliente", empresa.id, cliente.id] });
              onCambio();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

const MONEDA_FORMA: Record<string, string> = {
  efectivo_bs: "VES",
  efectivo_usd: "USD",
  pago_movil: "VES",
  transferencia: "VES",
  punto_venta: "VES",
  tarjeta: "VES",
  zelle: "USD",
  usdt: "USD",
  otro: "VES",
};

function CobrarFactura({
  documento,
  moneda,
  onCerrar,
  onCobrada,
}: {
  documento: DocumentoAbierto;
  moneda: string;
  onCerrar: () => void;
  onCobrada: () => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [monto, setMonto] = useState(documento.balance);
  const [forma, setForma] = useState<string | null>(null);

  const formas = useQuery({
    queryKey: ["formas-pago", empresa.id],
    staleTime: 60_000,
    queryFn: () => llamar<{ methods: FormaDePago[] }>("/v1/payment-methods"),
  });
  const configuradas = (formas.data?.methods ?? []).filter((f) => f.is_active);
  const opciones = [
    ...configuradas.map((f) => ({ value: `m:${f.id}`, label: f.name })),
    { value: "i:efectivo_bs", label: "Efectivo Bs." },
    { value: "i:efectivo_usd", label: "Efectivo USD" },
  ];

  const metodoElegido = forma?.startsWith("m:")
    ? configuradas.find((f) => `m:${f.id}` === forma)
    : undefined;
  const tipoDePago = metodoElegido?.kind ?? (forma !== null ? forma.slice(2) : null);
  const monedaCobro = tipoDePago !== null ? (MONEDA_FORMA[tipoDePago] ?? moneda) : moneda;

  const cobrar = useMutation({
    mutationFn: () =>
      llamar("/v1/payments", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          document_id: documento.id,
          currency: monedaCobro,
          amount: monto.trim().replace(",", "."),
          instrument: tipoDePago,
          ...(metodoElegido === undefined ? {} : { account_id: metodoElegido.account_id }),
        }),
      }),
    onSuccess: () => {
      toast.success("Cobro registrado");
      onCobrada();
    },
    onError: (e) => toast.error("No se pudo cobrar", errorDePersona(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-sm">
        <DialogTitle>
          Cobrar {documento.series}-{String(documento.document_number ?? "")}
        </DialogTitle>
        <DialogDescription>
          Puede ser un abono: lo que cobres se resta de la deuda.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <FormField label="¿Cómo te pagó?" required>
            {(p) => (
              <SimpleSelect
                id={p.id}
                value={forma}
                onValueChange={(v) => {
                  // Si la forma nueva vive en OTRA moneda, el monto tecleado
                  // deja de significar lo mismo: se limpia, no se reinterpreta.
                  const metodo = v.startsWith("m:")
                    ? configuradas.find((f) => `m:${f.id}` === v)
                    : undefined;
                  const inst = metodo?.kind ?? v.slice(2);
                  const monedaNueva = MONEDA_FORMA[inst] ?? moneda;
                  if (monedaNueva !== monedaCobro) setMonto("");
                  setForma(v);
                }}
                options={opciones}
              />
            )}
          </FormField>
          <FormField
            label="¿Cuánto te pagó?"
            required
            {...(monedaCobro !== moneda
              ? { hint: "En la moneda con la que pagó; el sistema convierte a la tasa de hoy." }
              : {})}
          >
            {(p) => (
              <MoneyInput
                {...p}
                value={monto}
                onChange={setMonto}
                currency={monedaCobro === "VES" ? "Bs." : monedaCobro}
              />
            )}
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={
              forma === null || !importeValido(monto.trim().replace(",", ".")) || cobrar.isPending
            }
            onClick={() => cobrar.mutate()}
          >
            Registrar cobro
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
