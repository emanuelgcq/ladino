import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Plus } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona } from "../../lib.js";
import { Badge } from "../../ui/badge.js";
import { Button } from "../../ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card.js";
import { Input } from "../../ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog.js";
import { FormField } from "../../components/forms.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { useToast } from "../../ui/toast.js";

/**
 * DEPÓSITOS (ADR-0049, migración 60): el primero nace con el negocio; los demás, aquí.
 *
 * El QA de pantalla del 2026-09-15 encontró que solo se podía CREAR: un depósito no se
 * renombraba, no se apagaba y no había forma de decir cuál es el principal — y la caja
 * tomaba el primero por código, así que uno nuevo podía dejarla sin vender. Ahora cada
 * fila dice cuál es el principal (de ahí descuenta la caja y llega la compra simple) y
 * se puede renombrar, hacer principal o apagar. El servidor impide apagar el principal
 * o un depósito con mercancía, y lo dice.
 */
interface Deposito {
  id: string;
  code: string;
  name: string;
  status: "active" | "inactive";
  is_default: boolean;
}

type Accion =
  | { tipo: "renombrar"; deposito: Deposito }
  | { tipo: "principal"; deposito: Deposito }
  | { tipo: "apagar"; deposito: Deposito }
  | { tipo: "encender"; deposito: Deposito };

interface CambioDeposito {
  name?: string;
  status?: "active" | "inactive";
  make_default?: true;
}

export function Depositos(): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const [creando, setCreando] = useState(false);
  const [accion, setAccion] = useState<Accion | null>(null);
  const gestiona = puede("warehouse.manage");

  const depositos = useQuery({
    queryKey: ["depositos", empresa.id],
    queryFn: () => llamar<Deposito[]>("/v1/warehouses"),
  });
  const recargar = (): void => {
    void qc.invalidateQueries({ queryKey: ["depositos", empresa.id] });
    void qc.invalidateQueries({ queryKey: ["almacenes", empresa.id] });
  };

  const cambiar = useMutation({
    mutationFn: (v: { id: string; cuerpo: CambioDeposito }) =>
      llamar(`/v1/warehouses/${v.id}`, {
        method: "PATCH",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, ...v.cuerpo }),
      }),
    onSuccess: () => {
      toast.success("Depósito actualizado");
      recargar();
    },
    onError: (e) => toast.error("No se pudo cambiar el depósito", errorDePersona(e)),
  });

  async function confirmar(cuerpo: CambioDeposito): Promise<void> {
    if (accion === null) return;
    await cambiar.mutateAsync({ id: accion.deposito.id, cuerpo });
    setAccion(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Depósitos</CardTitle>
        {gestiona && (
          <Button variant="secondary" size="sm" onClick={() => setCreando(true)}>
            <Plus /> Nuevo depósito
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        <CardDescription>
          Donde vive la mercancía. La caja descuenta del <strong>principal</strong> y ahí llegan las
          compras; con más de uno, la compra pregunta a cuál llega.
        </CardDescription>
        {depositos.isPending ? (
          <p className="text-[0.88rem] text-muted-foreground">Cargando…</p>
        ) : depositos.isError ? (
          <div className="space-y-2">
            <p role="alert" className="text-[0.88rem] text-destructive-soft-foreground">
              No se pudieron cargar los depósitos: {errorDePersona(depositos.error)}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void depositos.refetch()}>
              Reintentar
            </Button>
          </div>
        ) : depositos.data.length === 0 ? (
          <p className="text-[0.88rem] text-muted-foreground">
            Sin depósitos todavía: el primero nace con el negocio.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {depositos.data.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <Boxes className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="text-[0.92rem] font-medium">{d.name}</span>{" "}
                  <span className="font-mono text-[0.75rem] text-faint-foreground">{d.code}</span>
                </span>
                {d.is_default && <Badge tone="accent">Principal</Badge>}
                {d.status === "inactive" && <Badge tone="neutral">Apagado</Badge>}
                {gestiona && (
                  <span className="flex flex-wrap gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setAccion({ tipo: "renombrar", deposito: d })}
                    >
                      Renombrar
                    </Button>
                    {!d.is_default && d.status === "active" && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setAccion({ tipo: "principal", deposito: d })}
                        >
                          Hacer principal
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setAccion({ tipo: "apagar", deposito: d })}
                        >
                          Apagar
                        </Button>
                      </>
                    )}
                    {d.status === "inactive" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setAccion({ tipo: "encender", deposito: d })}
                      >
                        Encender
                      </Button>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {creando && (
        <NuevoDeposito
          onCerrar={(hecho) => {
            setCreando(false);
            if (hecho) recargar();
          }}
        />
      )}
      {accion?.tipo === "renombrar" && (
        <RenombrarDeposito
          deposito={accion.deposito}
          ocupado={cambiar.isPending}
          onCerrar={() => setAccion(null)}
          onGuardar={(name) => void confirmar({ name }).catch(() => undefined)}
        />
      )}
      <ConfirmDialog
        open={accion?.tipo === "principal"}
        onOpenChange={(v) => !v && setAccion(null)}
        title={`Hacer principal «${accion?.deposito.name ?? ""}»`}
        confirmLabel="Hacer principal"
        onConfirm={() => confirmar({ make_default: true })}
      >
        Desde ahora la caja descuenta la mercancía de este depósito y las compras llegan aquí por
        defecto. Lo que ya está en los otros depósitos no se mueve solo: transfiérelo desde
        Inventario si hace falta.
      </ConfirmDialog>
      <ConfirmDialog
        open={accion?.tipo === "apagar"}
        onOpenChange={(v) => !v && setAccion(null)}
        title={`Apagar «${accion?.deposito.name ?? ""}»`}
        confirmLabel="Apagar el depósito"
        onConfirm={() => confirmar({ status: "inactive" })}
      >
        Un depósito apagado no recibe ni despacha mercancía; su historia se conserva. Solo se apaga
        vacío: si todavía tiene mercancía, transfiérela a otro primero.
      </ConfirmDialog>
      <ConfirmDialog
        open={accion?.tipo === "encender"}
        onOpenChange={(v) => !v && setAccion(null)}
        title={`Encender «${accion?.deposito.name ?? ""}»`}
        confirmLabel="Encender el depósito"
        onConfirm={() => confirmar({ status: "active" })}
      >
        Vuelve a recibir y despachar mercancía.
      </ConfirmDialog>
    </Card>
  );
}

function RenombrarDeposito({
  deposito,
  ocupado,
  onCerrar,
  onGuardar,
}: {
  deposito: Deposito;
  ocupado: boolean;
  onCerrar: () => void;
  onGuardar: (name: string) => void;
}): React.JSX.Element {
  const [nombre, setNombre] = useState(deposito.name);
  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar()}>
      <DialogContent className="max-w-sm">
        <DialogTitle>Renombrar el depósito</DialogTitle>
        <DialogDescription>
          El código ({deposito.code}) no cambia: es el que aparece en los movimientos.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <FormField label="Nombre" required>
            {(p) => (
              <Input {...p} value={nombre} onChange={(e) => setNombre(e.target.value)} autoFocus />
            )}
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCerrar}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            disabled={nombre.trim() === "" || nombre.trim() === deposito.name || ocupado}
            onClick={() => onGuardar(nombre.trim())}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NuevoDeposito({ onCerrar }: { onCerrar: (hecho: boolean) => void }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [nombre, setNombre] = useState("");
  const [codigo, setCodigo] = useState("");
  const codigoLimpio = codigo.trim().toUpperCase();
  // La misma regla que el servidor: corto, sin tildes ni espacios (QA 2026-09-15, h. 47).
  const codigoValido = /^[A-Z0-9][A-Z0-9_-]{0,11}$/.test(codigoLimpio);

  const crear = useMutation({
    mutationFn: () =>
      llamar("/v1/warehouses", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          code: codigoLimpio,
          name: nombre.trim(),
        }),
      }),
    onSuccess: () => {
      toast.success("Depósito creado", nombre.trim());
      onCerrar(true);
    },
    onError: (e) => toast.error("No se pudo crear", errorDePersona(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-sm">
        <DialogTitle>Nuevo depósito</DialogTitle>
        <DialogDescription>
          Un código corto y un nombre que se entienda. El principal sigue siendo el que ya tienes:
          se cambia después, si quieres.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <FormField label="Nombre" required>
            {(p) => (
              <Input
                {...p}
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Depósito del fondo"
                autoFocus
              />
            )}
          </FormField>
          <FormField
            label="Código"
            required
            hint="Corto y único, sin tildes ni espacios: W2, FONDO…"
            error={
              codigo.trim() !== "" && !codigoValido
                ? "Solo letras sin tilde, números, guion o guion bajo; hasta 12."
                : undefined
            }
          >
            {(p) => (
              <Input
                {...p}
                className="font-mono uppercase"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
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
            disabled={nombre.trim() === "" || !codigoValido || crear.isPending}
            onClick={() => crear.mutate()}
          >
            Crear depósito
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
