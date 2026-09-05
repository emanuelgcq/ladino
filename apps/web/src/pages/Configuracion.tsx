import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card.js";
import { SimpleSelect } from "../ui/select.js";
import { Switch } from "../ui/switch.js";
import { Label } from "../ui/input.js";
import { useToast } from "../ui/toast.js";
import { useSesion } from "../app/session.js";
import { errorDePersona } from "../lib.js";
import { setTema, temaActual, type ThemeChoice } from "../theme.js";
import { mostrarTodosLosModulos, setMostrarTodos } from "../app/shell.js";
import { UsuariosYRoles } from "./configuracion/Usuarios.js";
import { Depositos } from "./configuracion/Depositos.js";

/**
 * Configuración. Fase A trae lo que gobierna la EXPERIENCIA: tema, divulgación
 * de módulos y la puesta a punto fiscal; el cambio del flujo de Vender añade
 * la sección de Ventas (ajustes de empresa, con permiso y auditoría en el
 * servidor). El resto de la configuración de negocio sigue en cada módulo.
 */
export function Configuracion(): React.JSX.Element {
  const [tema, setTemaLocal] = useState<ThemeChoice>(temaActual);
  const [todos, setTodos] = useState(mostrarTodosLosModulos);
  const { empresa, llamar, puede } = useSesion();
  const toast = useToast();
  const qc = useQueryClient();

  const ajustes = useQuery({
    queryKey: ["ajustes", empresa.id],
    queryFn: () => llamar<{ allow_unidentified_sales: boolean }>("/v1/company-settings"),
  });
  const cambiar = useMutation({
    mutationFn: (v: boolean) =>
      llamar("/v1/company-settings", {
        method: "PUT",
        body: JSON.stringify({ allow_unidentified_sales: v }),
      }),
    onSuccess: () => {
      toast.success("Guardado");
      void qc.invalidateQueries({ queryKey: ["ajustes", empresa.id] });
    },
    onError: (e) => {
      toast.error("No se pudo guardar", errorDePersona(e));
      void qc.invalidateQueries({ queryKey: ["ajustes", empresa.id] });
    },
  });

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">Configuración</h1>

      <Card>
        <CardHeader>
          <CardTitle>Puesta a punto fiscal</CardTitle>
        </CardHeader>
        <CardContent>
          <CardDescription className="mb-3">
            Lo que una empresa nueva necesita cargar antes de emitir su primera factura: alícuota
            con fuente legal, tasa BCV, régimen fiscal y rango de numeración.
          </CardDescription>
          <Link
            to="/admin/facturacion-fiscal"
            className="inline-flex items-center gap-2 rounded-sm bg-accent px-3 py-1.5 text-[0.9rem] font-medium text-accent-foreground hover:bg-accent-hover"
          >
            <ClipboardCheck className="size-4" /> Abrir la lista de puesta a punto
          </Link>
        </CardContent>
      </Card>

      {/* ADR-0049: quién entra y con qué oficio — solo para quien gobierna
          personas (membership.manage, el dueño). */}
      {puede("membership.manage") && <UsuariosYRoles />}
      {puede("warehouse.manage") && <Depositos />}

      <Card>
        <CardHeader>
          <CardTitle>Apariencia</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="cfg-tema">Tema</Label>
              <CardDescription>
                «Según el sistema» sigue a tu sistema operativo; elegir claro u oscuro lo fija.
              </CardDescription>
            </div>
            <div className="w-44">
              <SimpleSelect
                id="cfg-tema"
                value={tema}
                onValueChange={(v) => {
                  const eleccion = v as ThemeChoice;
                  setTema(eleccion);
                  setTemaLocal(eleccion);
                }}
                options={[
                  { value: "system", label: "Según el sistema" },
                  { value: "light", label: "Claro" },
                  { value: "dark", label: "Oscuro" },
                ]}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ventas</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="cfg-sin-identificar">
                Permitir ventas sin identificar al cliente
              </Label>
              <CardDescription>
                Encendido, el punto de venta ofrece «Venta sin identificar» (va al Consumidor final
                de sistema). Apagado, la cédula o el RIF son obligatorios SIEMPRE — y el servidor
                también lo exige, no solo la pantalla.
              </CardDescription>
            </div>
            <Switch
              id="cfg-sin-identificar"
              checked={ajustes.data?.allow_unidentified_sales ?? true}
              disabled={ajustes.isLoading || cambiar.isPending}
              onCheckedChange={(v: boolean) => cambiar.mutate(v)}
              aria-label="Permitir ventas sin identificar al cliente"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Módulos</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="cfg-todos">Mostrar todos los módulos</Label>
              <CardDescription>
                Compras, Contabilidad y Libros fiscales aparecen solos cuando la empresa tiene datos
                en ellos. Actívalo para verlos siempre — la bodega ve un sistema simple; la cadena,
                el completo. Misma app.
              </CardDescription>
            </div>
            <Switch
              id="cfg-todos"
              checked={todos}
              onCheckedChange={(v: boolean) => {
                setMostrarTodos(v);
                setTodos(v);
              }}
              aria-label="Mostrar todos los módulos"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
