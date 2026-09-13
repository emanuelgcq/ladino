import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Camera, Pencil } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona, LlamadaApiError } from "../../lib.js";
import { Button } from "../../ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog.js";
import { Input, Textarea } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import { useToast } from "../../ui/toast.js";
import { FormField } from "../../components/forms.js";
import { Link } from "react-router";
import { formatearDocumento } from "../negocio/comunes.js";
import { Recortador } from "../registro/Registro.js";

/**
 * MI EMPRESA (Configuración → la tarjeta del negocio): todos los campos del
 * registro, editables SEGÚN LA POLÍTICA de tres niveles (PARTE 4):
 *
 *   · perfil (nombre comercial, rubro, contacto, ciudad): libre;
 *   · razón social y dirección fiscal: libres SIN documentos; con documentos,
 *     el servidor exige motivo (422) y aquí se pide en el mismo diálogo, con
 *     las dos advertencias de la PARTE 3;
 *   · el RIF: puerta propia — ponerlo por primera vez (PEND-*) es flujo
 *     normal; cambiarlo con documentos está BLOQUEADO (el 422 del servidor se
 *     muestra tal cual); el dedazo va por «Corregir RIF», acción aparte con
 *     motivo y aviso de consultar al contador.
 *
 * La pantalla muestra además el MODO del negocio (recibos / formas libres /
 * administrativo) con su enlace para cambiarlo.
 */

interface EmpresaFila {
  id: string;
  legal_name: string;
  trade_name: string | null;
  tax_id: string;
  fiscal_address: string | null;
  business_type: string | null;
  phone: string | null;
  whatsapp: string | null;
  city: string | null;
  state: string | null;
  logo_url: string | null;
}

const RUBROS: { value: string; label: string }[] = [
  { value: "bodega", label: "Bodega y abastos" },
  { value: "ropa", label: "Ropa y calzado" },
  { value: "ferreteria", label: "Ferretería" },
  { value: "farmacia", label: "Farmacia" },
  { value: "restaurante", label: "Restaurante o comida" },
  { value: "repuestos", label: "Repuestos" },
  { value: "servicios", label: "Servicios" },
  { value: "distribuidora", label: "Distribuidora" },
  { value: "otro", label: "Otro" },
];

const MODO: Record<string, { etiqueta: string; enlace: string }> = {
  sin_facturacion: { etiqueta: "Vendes con recibos", enlace: "/empezar" },
  formatos_libres: { etiqueta: "Facturas por formas libres", enlace: "/admin/facturacion-fiscal" },
  sin_emision: {
    etiqueta: "Administrativo sin emisión (facturas por tu máquina fiscal)",
    enlace: "/admin/facturacion-fiscal",
  },
};

export function MiEmpresa(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [editando, setEditando] = useState(false);
  const [logoAbierto, setLogoAbierto] = useState(false);
  const [rifAbierto, setRifAbierto] = useState<"poner" | "corregir" | null>(null);

  const empresas = useQuery({
    queryKey: ["mi-empresa", empresa.id],
    queryFn: async () => {
      const lista = await llamar<EmpresaFila[]>("/v1/companies");
      return lista.find((e) => e.id === empresa.id) ?? null;
    },
  });
  const setupFiscal = useQuery({
    queryKey: ["empezar-fiscal", empresa.id],
    staleTime: 5 * 60_000,
    queryFn: () => llamar<{ current_regime: string | null }>("/v1/fiscal/setup"),
  });
  const recargar = () => void qc.invalidateQueries({ queryKey: ["mi-empresa", empresa.id] });

  const e = empresas.data;
  const sinRif = e !== null && e !== undefined && e.tax_id.startsWith("PEND-");
  const modo = MODO[setupFiscal.data?.current_regime ?? ""] ?? null;

  const subirLogo = useMutation({
    mutationFn: async (blob: Blob) => {
      const form = new FormData();
      form.append("file", new File([blob], "logo.png", { type: "image/png" }));
      return llamar(`/v1/companies/logo`, { method: "POST", body: form });
    },
    onSuccess: () => {
      toast.success("Logo actualizado", "Sale en la app y en tus facturas.");
      setLogoAbierto(false);
      recargar();
    },
    onError: (err) => toast.error("No se pudo subir el logo", errorDePersona(err)),
  });

  if (e === null || e === undefined) {
    // «Cargando…» solo mientras carga: si la llamada falló, o la empresa
    // activa no vino en la lista, se dice y se ofrece reintentar — antes era
    // un «Cargando…» eterno (auditoría 2026-09-11).
    const fallo = empresas.isError
      ? errorDePersona(empresas.error)
      : empresas.data === null
        ? "La empresa activa no aparece en tu lista de empresas."
        : null;
    return (
      <Card>
        <CardHeader>
          <CardTitle>Mi empresa</CardTitle>
        </CardHeader>
        <CardContent>
          {fallo === null ? (
            <p className="text-muted-foreground">Cargando…</p>
          ) : (
            <div className="space-y-2">
              <p role="alert" className="text-[0.88rem] text-destructive-soft-foreground">
                No se pudo cargar la ficha del negocio: {fallo}
              </p>
              <Button variant="secondary" size="sm" onClick={() => void empresas.refetch()}>
                Reintentar
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Mi empresa</CardTitle>
        <CardDescription>
          La tarjeta de tu negocio: lo que ven tus clientes y lo que sale en tus documentos.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* La tarjeta, como en el registro. */}
        <div className="flex items-center gap-4 rounded-lg border border-border bg-surface-muted/40 p-4">
          <button
            aria-label="Cambiar el logo"
            onClick={() => setLogoAbierto(true)}
            className="group relative shrink-0"
          >
            {e.logo_url !== null ? (
              <img
                src={e.logo_url}
                alt=""
                className="size-16 rounded-xl border border-border object-cover"
              />
            ) : (
              <span className="flex size-16 items-center justify-center rounded-xl bg-accent-soft text-2xl font-semibold text-accent-soft-foreground">
                {(e.trade_name ?? e.legal_name).slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full border border-border bg-surface shadow-soft transition-transform group-hover:scale-110">
              <Camera className="size-3.5 text-muted-foreground" />
            </span>
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[1.1rem] font-semibold">{e.trade_name ?? e.legal_name}</p>
            <p className="text-[0.88rem] text-muted-foreground">
              {RUBROS.find((r) => r.value === e.business_type)?.label ?? "Negocio"}
              {e.city !== null ? ` · ${e.city}` : ""}
              {e.state !== null ? `, ${e.state}` : ""}
            </p>
            {modo !== null && (
              <p className="mt-0.5 text-[0.82rem] text-muted-foreground">
                {modo.etiqueta} ·{" "}
                <Link to={modo.enlace} className="text-accent-soft-foreground hover:underline">
                  cambiar
                </Link>
              </p>
            )}
          </div>
          <Button variant="secondary" size="sm" onClick={() => setEditando(true)}>
            <Pencil /> Editar
          </Button>
        </div>

        {/* Los datos fiscales, visualmente APARTE: son otra liga. */}
        <div className="rounded-lg border border-border p-4">
          <div className="flex items-center gap-2 text-[0.85rem] font-medium text-muted-foreground">
            <Building2 className="size-4" /> Datos fiscales
          </div>
          <div className="mt-2 grid gap-1 text-[0.92rem] sm:grid-cols-2">
            <p className="text-muted-foreground">
              RIF:{" "}
              <span className="font-mono text-foreground tabular-nums">
                {sinRif ? "todavía no" : formatearDocumento(e.tax_id)}
              </span>
            </p>
            <p className="text-muted-foreground">
              Razón social: <span className="text-foreground">{e.legal_name}</span>
            </p>
            <p className="text-muted-foreground sm:col-span-2">
              Dirección fiscal: <span className="text-foreground">{e.fiscal_address ?? "—"}</span>
            </p>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {sinRif ? (
              <Button variant="primary" size="sm" onClick={() => setRifAbierto("poner")}>
                Poner mi RIF
              </Button>
            ) : (
              <>
                <Button variant="secondary" size="sm" onClick={() => setRifAbierto("poner")}>
                  Cambiar el RIF
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setRifAbierto("corregir")}>
                  Corregir RIF (error de tipeo)
                </Button>
              </>
            )}
          </div>
        </div>
      </CardContent>

      {editando && (
        <EditarEmpresa
          e={e}
          onCerrar={(hecho) => {
            setEditando(false);
            if (hecho) recargar();
          }}
        />
      )}
      {logoAbierto && (
        <Dialog open onOpenChange={(v) => !v && setLogoAbierto(false)}>
          <DialogContent className="max-w-md">
            <DialogTitle>El logo del negocio</DialogTitle>
            <DialogDescription>
              Cuadrado se ve mejor. Sale en la app y arriba de tus facturas y recibos.
            </DialogDescription>
            <div className="pt-2">
              <Recortador
                logoUrl={null}
                onLogo={(blob) => {
                  subirLogo.mutate(blob);
                }}
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setLogoAbierto(false)}>
                {subirLogo.isPending ? "Subiendo…" : "Cerrar"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {rifAbierto !== null && (
        <DialogoRif
          modo={rifAbierto}
          sinRif={sinRif}
          rifActual={e.tax_id}
          hayDireccion={e.fiscal_address !== null}
          onCerrar={(hecho) => {
            setRifAbierto(null);
            if (hecho) recargar();
          }}
        />
      )}
    </Card>
  );
}

function EditarEmpresa({
  e,
  onCerrar,
}: {
  e: EmpresaFila;
  onCerrar: (hecho: boolean) => void;
}): React.JSX.Element {
  const { llamar } = useSesion();
  const toast = useToast();
  const [form, setForm] = useState({
    trade_name: e.trade_name ?? "",
    business_type: e.business_type,
    phone: e.phone ?? "",
    whatsapp: e.whatsapp ?? "",
    city: e.city ?? "",
    state: e.state ?? "",
    legal_name: e.legal_name,
    fiscal_address: e.fiscal_address ?? "",
  });
  const [motivo, setMotivo] = useState("");
  const [pideMotivo, setPideMotivo] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const identidadCambia =
    form.legal_name.trim() !== e.legal_name ||
    (form.fiscal_address.trim() !== "" && form.fiscal_address.trim() !== (e.fiscal_address ?? ""));

  const guardar = useMutation({
    mutationFn: (reason?: string) => {
      const oNull = (v: string) => (v.trim() === "" ? null : v.trim());
      return llamar(`/v1/companies/profile`, {
        method: "PATCH",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          trade_name: oNull(form.trade_name),
          business_type: form.business_type,
          phone: oNull(form.phone),
          whatsapp: oNull(form.whatsapp),
          city: oNull(form.city),
          state: oNull(form.state),
          ...(form.legal_name.trim() === "" ? {} : { legal_name: form.legal_name.trim() }),
          ...(form.fiscal_address.trim() === ""
            ? {}
            : { fiscal_address: form.fiscal_address.trim() }),
          ...(reason === undefined || reason.trim() === "" ? {} : { reason: reason.trim() }),
        }),
      });
    },
    onSuccess: () => {
      toast.success("Empresa actualizada");
      onCerrar(true);
    },
    onError: (err, reason) => {
      // El servidor pide MOTIVO cuando la identidad cambia con documentos
      // emitidos: responde 422 VALIDATION_FAILED (packages/domain/src/
      // company-profile.ts, nivel 2). Se reconoce por status + código y por
      // la situación —cambia la identidad y todavía no se mandó motivo—, no
      // por el texto del mensaje. Se pide aquí mismo, con las advertencias,
      // y se reintenta.
      const exigeMotivo =
        err instanceof LlamadaApiError &&
        err.status === 422 &&
        err.body.code === "VALIDATION_FAILED" &&
        identidadCambia &&
        (reason === undefined || reason.trim() === "");
      if (exigeMotivo) setPideMotivo(true);
      else setError(err);
    },
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-xl">
        <DialogTitle>Editar mi empresa</DialogTitle>
        <DialogDescription>El RIF se cambia aparte, con su propia puerta.</DialogDescription>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Nombre comercial">
            {(p) => (
              <Input
                {...p}
                value={form.trade_name}
                onChange={(ev) => setForm({ ...form, trade_name: ev.target.value })}
              />
            )}
          </FormField>
          <FormField label="Rubro">
            {(p) => (
              <SimpleSelect
                id={p.id}
                value={form.business_type}
                onValueChange={(v) => setForm({ ...form, business_type: v })}
                options={RUBROS}
                placeholder="Elige el rubro…"
              />
            )}
          </FormField>
          <FormField label="Teléfono">
            {(p) => (
              <Input
                {...p}
                value={form.phone}
                onChange={(ev) => setForm({ ...form, phone: ev.target.value })}
              />
            )}
          </FormField>
          <FormField label="WhatsApp">
            {(p) => (
              <Input
                {...p}
                value={form.whatsapp}
                onChange={(ev) => setForm({ ...form, whatsapp: ev.target.value })}
              />
            )}
          </FormField>
          <FormField label="Ciudad">
            {(p) => (
              <Input
                {...p}
                value={form.city}
                onChange={(ev) => setForm({ ...form, city: ev.target.value })}
              />
            )}
          </FormField>
          <FormField label="Estado">
            {(p) => (
              <Input
                {...p}
                value={form.state}
                onChange={(ev) => setForm({ ...form, state: ev.target.value })}
              />
            )}
          </FormField>
          <FormField
            label="Razón social"
            hint="El nombre legal. Cambiarla con facturas emitidas queda en acta."
          >
            {(p) => (
              <Input
                {...p}
                value={form.legal_name}
                onChange={(ev) => setForm({ ...form, legal_name: ev.target.value })}
              />
            )}
          </FormField>
          <FormField label="Dirección fiscal">
            {(p) => (
              <Input
                {...p}
                value={form.fiscal_address}
                onChange={(ev) => setForm({ ...form, fiscal_address: ev.target.value })}
              />
            )}
          </FormField>
        </div>
        {pideMotivo && (
          <div className="mt-3 space-y-2 rounded-md border border-warning-soft-foreground/30 bg-warning-soft p-3">
            <p className="text-[0.88rem] text-warning-soft-foreground">
              Ya emitiste documentos con estos datos. Las facturas ya emitidas conservan los datos
              con los que salieron. Si facturas por formas libres, el papel preimpreso con los datos
              viejos queda inválido: necesitarás talonarios nuevos y{" "}
              <Link to="/admin/facturacion-fiscal" className="underline">
                cargar el rango nuevo
              </Link>
              .
            </p>
            <FormField label="¿Por qué cambia?" required hint="Queda en la auditoría.">
              {(p) => (
                <Textarea
                  {...p}
                  rows={2}
                  value={motivo}
                  onChange={(ev) => setMotivo(ev.target.value)}
                />
              )}
            </FormField>
          </div>
        )}
        {error !== null && (
          <p role="alert" className="mt-3 text-[0.85rem] text-destructive-soft-foreground">
            {errorDePersona(error)}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onCerrar(false)} disabled={guardar.isPending}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={guardar.isPending || (pideMotivo && motivo.trim().length < 3)}
            onClick={() => guardar.mutate(pideMotivo ? motivo : undefined)}
          >
            {guardar.isPending
              ? "Guardando…"
              : identidadCambia && pideMotivo
                ? "Guardar con acta"
                : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DialogoRif({
  modo,
  sinRif,
  rifActual,
  hayDireccion,
  onCerrar,
}: {
  modo: "poner" | "corregir";
  sinRif: boolean;
  rifActual: string;
  hayDireccion: boolean;
  onCerrar: (hecho: boolean) => void;
}): React.JSX.Element {
  const { llamar } = useSesion();
  const toast = useToast();
  const [rif, setRif] = useState("");
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const normalizado = rif
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const esCorreccion = modo === "corregir";

  const enviar = useMutation({
    mutationFn: () =>
      esCorreccion
        ? llamar(`/v1/companies/tax-id/correct`, {
            method: "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ tax_id: normalizado, reason: motivo.trim() }),
          })
        : llamar(`/v1/companies/tax-id`, {
            method: "PUT",
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ tax_id: normalizado }),
          }),
    onSuccess: () => {
      toast.success(
        esCorreccion ? "RIF corregido" : sinRif ? "RIF registrado" : "RIF cambiado",
        esCorreccion
          ? "Quedó el acta. Consulta con tu contador si algo ya facturado debe reemitirse."
          : undefined,
      );
      onCerrar(true);
    },
    onError: (err) => setError(errorDePersona(err)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-md">
        <DialogTitle>
          {esCorreccion ? "Corregir el RIF" : sinRif ? "Poner mi RIF" : "Cambiar el RIF"}
        </DialogTitle>
        <DialogDescription>
          {esCorreccion
            ? "Solo para un error de tipeo descubierto tarde. Exige motivo y deja acta — y conviene consultar al contador sobre lo ya facturado."
            : sinRif
              ? "Con tu RIF activas las facturas. La razón social y la dirección fiscal tienen que estar cargadas."
              : "Sin documentos emitidos, el cambio es directo y queda auditado."}
        </DialogDescription>
        <div className="space-y-3 pt-2">
          {!hayDireccion && (
            <p className="rounded-md bg-warning-soft p-3 text-[0.88rem] text-warning-soft-foreground">
              Primero carga la dirección fiscal (en «Editar»): es la que sale en tus facturas.
            </p>
          )}
          {!sinRif && !esCorreccion && (
            <p className="text-[0.85rem] text-muted-foreground">
              RIF actual: <span className="font-mono">{formatearDocumento(rifActual)}</span>
            </p>
          )}
          <FormField label={esCorreccion ? "El RIF correcto" : "El RIF"} required>
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                placeholder="J-40123456-7"
                value={rif}
                onChange={(ev) => setRif(ev.target.value)}
              />
            )}
          </FormField>
          {esCorreccion && (
            <FormField label="¿Qué pasó?" required hint="Queda en la auditoría.">
              {(p) => (
                <Textarea
                  {...p}
                  rows={2}
                  value={motivo}
                  onChange={(ev) => setMotivo(ev.target.value)}
                />
              )}
            </FormField>
          )}
          {error !== null && (
            <p
              role="alert"
              className="rounded-md bg-destructive-soft px-3 py-2 text-[0.88rem] text-destructive-soft-foreground"
            >
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onCerrar(false)} disabled={enviar.isPending}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={
              enviar.isPending ||
              normalizado.length < 3 ||
              (esCorreccion && motivo.trim().length < 3)
            }
            onClick={() => enviar.mutate()}
          >
            {enviar.isPending ? "Guardando…" : esCorreccion ? "Corregir con acta" : "Guardar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
