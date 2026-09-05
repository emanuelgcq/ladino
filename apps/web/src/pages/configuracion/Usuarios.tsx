import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus, UserX, UserCheck, X } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona } from "../../lib.js";
import { Button } from "../../ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card.js";
import { Badge } from "../../ui/badge.js";
import { Input } from "../../ui/input.js";
import { SimpleSelect } from "../../ui/select.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../ui/dialog.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { FormField } from "../../components/forms.js";
import { useToast } from "../../ui/toast.js";

/**
 * USUARIOS Y ROLES (ADR-0049): quién entra al negocio y con qué oficio. La
 * persona se registra sola en Ladino con su correo; el dueño la agrega aquí.
 * Los roles son los seis de sistema — oficios, no matrices de permisos.
 */
interface Asignacion {
  id: string;
  role_key: string;
  role_name: string;
  company_id: string | null;
}
interface Miembro {
  membership_id: string;
  user_id: string;
  email: string | null;
  status: string;
  assignments: Asignacion[];
}

const ROLES = [
  {
    value: "cashier",
    label: "Cajero",
    detalle: "Vende, cobra y fía. No ve el dinero del negocio.",
  },
  {
    value: "store_manager",
    label: "Encargado",
    detalle: "Lo del cajero + mercancía, productos y el cierre de caja.",
  },
  {
    value: "back_office",
    label: "Administrador",
    detalle: "La operación completa: precios, compras, gastos, dinero y reportes.",
  },
  {
    value: "accountant",
    label: "Contador",
    detalle: "Contabilidad, cierres y libros. No vende ni toca maestros.",
  },
  {
    value: "warehouse_ops",
    label: "Operación de almacén",
    detalle: "Solo los verbos de mercancía: entra, sale, ajusta, mueve.",
  },
  {
    value: "owner",
    label: "Dueño",
    detalle: "Todo, incluida esta pantalla. Dalo solo a otro dueño de verdad.",
  },
];

export function UsuariosYRoles(): React.JSX.Element {
  const { empresa, llamar, session } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();
  const [agregando, setAgregando] = useState(false);
  const [quitando, setQuitando] = useState<{ miembro: Miembro; asignacion: Asignacion } | null>(
    null,
  );
  const [apagando, setApagando] = useState<Miembro | null>(null);

  const miembros = useQuery({
    queryKey: ["miembros", empresa.id],
    queryFn: () => llamar<{ members: Miembro[] }>("/v1/members"),
  });
  const recargar = () => void qc.invalidateQueries({ queryKey: ["miembros", empresa.id] });

  const quitar = useMutation({
    mutationFn: (asignacionId: string) =>
      llamar(`/v1/members/assignments/${asignacionId}`, {
        method: "DELETE",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      }),
    onSuccess: () => {
      toast.success("Rol quitado");
      recargar();
    },
    onError: (e) => toast.error("No se pudo quitar", errorDePersona(e)),
  });

  const cambiarEstado = useMutation({
    mutationFn: (m: { id: string; status: "active" | "inactive" }) =>
      llamar(`/v1/members/${m.id}/status`, {
        method: "PUT",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, status: m.status }),
      }),
    onSuccess: (_r, m) => {
      toast.success(m.status === "active" ? "Acceso reactivado" : "Acceso desactivado");
      recargar();
    },
    onError: (e) => toast.error("No se pudo cambiar el acceso", errorDePersona(e)),
  });

  const soyYo = (m: Miembro) => m.user_id === session.user.id;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usuarios y roles</CardTitle>
        <Button variant="primary" size="sm" onClick={() => setAgregando(true)}>
          <UserPlus /> Agregar persona
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <CardDescription>
          Cada persona se registra sola en Ladino con su correo; aquí le das su oficio. Lo que cada
          rol ve y puede hacer lo decide el servidor — quitar el rol corta el acceso en el momento.
        </CardDescription>
        {miembros.isLoading ? (
          <p className="text-muted-foreground">Cargando…</p>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {(miembros.data?.members ?? []).map((m) => (
              <div key={m.membership_id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.92rem] font-medium">
                    {m.email ?? "(sin correo)"}
                    {soyYo(m) && (
                      <span className="ml-1.5 text-[0.78rem] text-faint-foreground">tú</span>
                    )}
                  </span>
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {m.assignments.length === 0 && (
                      <Badge tone="neutral">Sin rol — no puede hacer nada</Badge>
                    )}
                    {m.assignments.map((a) => (
                      <Badge key={a.id} tone="accent" className="gap-1">
                        {a.role_name}
                        {!(soyYo(m) && a.role_key === "owner") && (
                          <button
                            aria-label={`Quitar el rol ${a.role_name}`}
                            className="hover:text-destructive-soft-foreground"
                            onClick={() => setQuitando({ miembro: m, asignacion: a })}
                          >
                            <X className="size-3" />
                          </button>
                        )}
                      </Badge>
                    ))}
                  </span>
                </span>
                {m.status !== "active" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => cambiarEstado.mutate({ id: m.membership_id, status: "active" })}
                  >
                    <UserCheck /> Reactivar
                  </Button>
                ) : (
                  !soyYo(m) && (
                    <Button variant="ghost" size="sm" onClick={() => setApagando(m)}>
                      <UserX /> Desactivar
                    </Button>
                  )
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {agregando && (
        <AgregarPersona
          onCerrar={(hecho) => {
            setAgregando(false);
            if (hecho) recargar();
          }}
        />
      )}

      <ConfirmDialog
        open={quitando !== null}
        onOpenChange={(v) => !v && setQuitando(null)}
        title="Quitar el rol"
        confirmLabel="Quitar el rol"
        destructive
        onConfirm={async () => {
          if (quitando !== null) await quitar.mutateAsync(quitando.asignacion.id);
          setQuitando(null);
        }}
      >
        {quitando?.miembro.email} deja de ser {quitando?.asignacion.role_name} ahora mismo: lo que
        ese rol le abría, se cierra en la siguiente pantalla que toque.
      </ConfirmDialog>

      <ConfirmDialog
        open={apagando !== null}
        onOpenChange={(v) => !v && setApagando(null)}
        title="Desactivar el acceso"
        confirmLabel="Desactivar"
        destructive
        onConfirm={async () => {
          if (apagando !== null) {
            await cambiarEstado.mutateAsync({ id: apagando.membership_id, status: "inactive" });
          }
          setApagando(null);
        }}
      >
        {apagando?.email} pierde el acceso COMPLETO al negocio, con todos sus roles. Su historial
        queda intacto y puedes reactivarle cuando quieras.
      </ConfirmDialog>
    </Card>
  );
}

function AgregarPersona({ onCerrar }: { onCerrar: (hecho: boolean) => void }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [correo, setCorreo] = useState("");
  const [rol, setRol] = useState<string | null>(null);

  const agregar = useMutation({
    mutationFn: () =>
      llamar("/v1/members", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, email: correo.trim(), role_key: rol }),
      }),
    onSuccess: () => {
      toast.success("Persona agregada", "Ya puede entrar con su oficio.");
      onCerrar(true);
    },
    onError: (e) => toast.error("No se pudo agregar", errorDePersona(e)),
  });

  const detalle = ROLES.find((r) => r.value === rol)?.detalle;

  return (
    <Dialog open onOpenChange={(v) => !v && onCerrar(false)}>
      <DialogContent className="max-w-md">
        <DialogTitle>Agregar persona</DialogTitle>
        <DialogDescription>
          Pídele que se registre primero en Ladino con su correo. Después la agregas aquí y su
          oficio decide lo que ve.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <FormField label="Correo" required>
            {(p) => (
              <Input
                {...p}
                type="email"
                value={correo}
                onChange={(e) => setCorreo(e.target.value)}
                placeholder="persona@correo.com"
                autoFocus
              />
            )}
          </FormField>
          <FormField label="Oficio" required {...(detalle === undefined ? {} : { hint: detalle })}>
            {(p) => (
              <SimpleSelect
                id={p.id}
                value={rol}
                onValueChange={setRol}
                placeholder="¿Qué hace en el negocio?"
                options={ROLES.map((r) => ({ value: r.value, label: r.label }))}
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
            disabled={correo.trim() === "" || rol === null || agregar.isPending}
            onClick={() => agregar.mutate()}
          >
            {agregar.isPending ? "Agregando…" : "Agregar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
