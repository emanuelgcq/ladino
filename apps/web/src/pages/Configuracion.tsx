import { useState } from "react";
import { Link } from "react-router";
import { ClipboardCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card.js";
import { SimpleSelect } from "../ui/select.js";
import { Switch } from "../ui/switch.js";
import { Label } from "../ui/input.js";
import { setTema, temaActual, type ThemeChoice } from "../theme.js";
import { mostrarTodosLosModulos, setMostrarTodos } from "../app/shell.js";

/**
 * Configuración. Fase A trae lo que gobierna la EXPERIENCIA: tema, divulgación
 * de módulos y la puesta a punto fiscal. La configuración de negocio sigue en
 * cada módulo, que es donde tiene su permiso y su auditoría.
 */
export function Configuracion(): React.JSX.Element {
  const [tema, setTemaLocal] = useState<ThemeChoice>(temaActual);
  const [todos, setTodos] = useState(mostrarTodosLosModulos);

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
            to="/configuracion/fiscal"
            className="inline-flex items-center gap-2 rounded-sm bg-accent px-3 py-1.5 text-[0.9rem] font-medium text-accent-foreground hover:bg-accent-hover"
          >
            <ClipboardCheck className="size-4" /> Abrir la lista de puesta a punto
          </Link>
        </CardContent>
      </Card>

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
