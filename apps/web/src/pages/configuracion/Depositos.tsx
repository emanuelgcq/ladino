import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Plus } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { errorDePersona } from "../../lib.js";
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
import { useToast } from "../../ui/toast.js";

/**
 * DEPÓSITOS (ADR-0049): el primero nace con el negocio; los demás, aquí. La
 * auditoría de superficie encontró POST /v1/warehouses sin ninguna puerta.
 */
interface Deposito {
  id: string;
  code: string;
  name: string;
}

export function Depositos(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const qc = useQueryClient();
  const [creando, setCreando] = useState(false);

  const depositos = useQuery({
    queryKey: ["depositos", empresa.id],
    queryFn: () => llamar<Deposito[]>("/v1/warehouses"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Depósitos</CardTitle>
        <Button variant="secondary" size="sm" onClick={() => setCreando(true)}>
          <Plus /> Nuevo depósito
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <CardDescription>
          Donde vive la mercancía. Con más de uno, Inventario gana el botón «Mover» y cada entrada
          pregunta a cuál llega.
        </CardDescription>
        <div className="flex flex-wrap gap-2">
          {(depositos.data ?? []).map((d) => (
            <span
              key={d.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[0.88rem]"
            >
              <Boxes className="size-3.5 text-muted-foreground" />
              {d.name}
              <span className="font-mono text-[0.75rem] text-faint-foreground">{d.code}</span>
            </span>
          ))}
        </div>
      </CardContent>
      {creando && (
        <NuevoDeposito
          onCerrar={(hecho) => {
            setCreando(false);
            if (hecho) void qc.invalidateQueries({ queryKey: ["depositos", empresa.id] });
          }}
        />
      )}
    </Card>
  );
}

function NuevoDeposito({ onCerrar }: { onCerrar: (hecho: boolean) => void }): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [nombre, setNombre] = useState("");
  const [codigo, setCodigo] = useState("");

  const crear = useMutation({
    mutationFn: () =>
      llamar("/v1/warehouses", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          code: codigo.trim().toUpperCase(),
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
        <DialogDescription>Un código corto y un nombre que se entienda.</DialogDescription>
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
          <FormField label="Código" required hint="Corto y único: W2, FONDO…">
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
            disabled={nombre.trim() === "" || codigo.trim() === "" || crear.isPending}
            onClick={() => crear.mutate()}
          >
            Crear depósito
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
