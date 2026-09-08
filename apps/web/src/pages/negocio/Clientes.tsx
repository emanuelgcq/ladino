import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus, Search, Users } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona } from "../../lib.js";
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
import { useToast } from "../../ui/toast.js";
import { FormField } from "../../components/forms.js";
import { formatearDocumento } from "./comunes.js";

/**
 * CLIENTES (Fase C, PARTE 9): a quién le vendo. SOLO la información del
 * cliente (decisión del dueño, 2026-09-05): la deuda, el cobro y el estado
 * de cuenta viven en Administración → Clientes. Aquí queda la lista, la
 * búsqueda y el alta rápida que infiere el tipo por el RIF (J/G = empresa,
 * V/E o vacío = persona).
 */

interface ClienteFila {
  id: string;
  legal_name: string;
  tax_id: string | null;
  phone: string | null;
  email?: string | null;
  fiscal_address?: string | null;
  is_system?: boolean;
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
  const { empresa, llamar, puede } = useSesion();
  const [busqueda, setBusqueda] = useState("");
  const [alta, setAlta] = useState(false);
  const [ficha, setFicha] = useState<ClienteFila | null>(null);
  const qc = useQueryClient();
  const q = useDebounced(busqueda.trim(), 250);

  const clientes = useQuery({
    queryKey: ["negocio-clientes", empresa.id, q],
    queryFn: () =>
      llamar<{ items: ClienteFila[]; total: number }>(
        `/v1/customers?per_page=100${q === "" ? "" : `&search=${encodeURIComponent(q)}`}`,
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
        {/* Importar es tarea ADMINISTRATIVA (regla de los dos mundos): el
            botón vive en Administración → Clientes, no aquí. */}
        <Button variant="primary" onClick={() => setAlta(true)}>
          <Plus /> Agregar cliente
        </Button>
      </div>

      {/* Quien administra encuentra aquí la puerta a la deuda y los cobros. */}
      {puede(["customer.tax_id.manage", "accounting.read"]) && (
        <Link
          to="/admin/clientes"
          className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 text-[0.9rem] transition-colors hover:border-accent hover:bg-accent-soft/30"
        >
          <span>
            ¿Quién te debe y cuánto? Está en <strong>Administración → Clientes</strong>.
          </span>
          <ArrowRight className="size-4 shrink-0 text-accent" />
        </Link>
      )}

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
          <FormField label="Teléfono" hint="Para avisarle cuando su pedido esté listo.">
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

/**
 * La ficha muestra los datos del cliente y permite CORREGIRLOS (nombre,
 * teléfono, email, dirección). El documento se cambia en la administración
 * —permiso propio, auditado— y la deuda vive allá entera.
 */
function FichaCliente({
  cliente,
  onCerrar,
  onCambio,
}: {
  cliente: ClienteFila;
  onCerrar: () => void;
  onCambio: () => void;
}): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const toast = useToast();
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState({
    legal_name: cliente.legal_name,
    phone: cliente.phone ?? "",
    email: cliente.email ?? "",
    fiscal_address: cliente.fiscal_address ?? "",
  });

  const oNull = (v: string) => (v.trim() === "" ? null : v.trim());
  const guardar = useMutation({
    mutationFn: () =>
      llamar(`/v1/customers/${cliente.id}`, {
        method: "PATCH",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          legal_name: form.legal_name.trim(),
          phone: oNull(form.phone),
          email: oNull(form.email),
          fiscal_address: oNull(form.fiscal_address),
        }),
      }),
    onSuccess: () => {
      toast.success("Cliente actualizado");
      onCambio();
      onCerrar();
    },
    onError: (e) => toast.error("No se pudo guardar", errorDePersona(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-sm">
        <DialogTitle>{cliente.legal_name}</DialogTitle>
        {!editando ? (
          <div className="space-y-2 pt-2 text-[0.92rem]">
            <p className="text-muted-foreground">
              Documento:{" "}
              <span className="text-foreground tabular-nums">
                {cliente.tax_id !== null ? formatearDocumento(cliente.tax_id) : "—"}
              </span>
            </p>
            <p className="text-muted-foreground">
              Teléfono: <span className="text-foreground">{cliente.phone ?? "—"}</span>
            </p>
            <p className="text-muted-foreground">
              Email: <span className="text-foreground">{cliente.email ?? "—"}</span>
            </p>
            <p className="text-muted-foreground">
              Dirección: <span className="text-foreground">{cliente.fiscal_address ?? "—"}</span>
            </p>
          </div>
        ) : (
          <div className="space-y-3 pt-2">
            <FormField label="Nombre" required>
              {(p) => (
                <Input
                  {...p}
                  value={form.legal_name}
                  onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="Teléfono">
              {(p) => (
                <Input
                  {...p}
                  inputMode="tel"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="Email">
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              )}
            </FormField>
            <FormField
              label="Dirección"
              hint="El documento (RIF o cédula) se cambia en la administración."
            >
              {(p) => (
                <Input
                  {...p}
                  value={form.fiscal_address}
                  onChange={(e) => setForm({ ...form, fiscal_address: e.target.value })}
                />
              )}
            </FormField>
          </div>
        )}
        <DialogFooter>
          {!editando ? (
            <>
              <Button variant="ghost" onClick={onCerrar}>
                Cerrar
              </Button>
              {puede("customer.manage") && (
                <Button variant="secondary" onClick={() => setEditando(true)}>
                  Editar
                </Button>
              )}
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setEditando(false)}>
                Volver
              </Button>
              <Button
                variant="primary"
                disabled={form.legal_name.trim() === "" || guardar.isPending}
                onClick={() => guardar.mutate()}
              >
                Guardar cambios
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
