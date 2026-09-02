import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, RefreshCw, Store, TrendingUp, TriangleAlert, Wallet } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { mostrarImporte, mostrarCantidad } from "../../money.js";
import { esCero } from "../../components/decimal-compare.js";
import { Button } from "../../ui/button.js";
import { Card, CardContent } from "../../ui/card.js";
import { fechaRelativa } from "./comunes.js";

/**
 * INICIO (Fase C, PARTE 12): cómo va el negocio, de un vistazo. El número
 * grande es lo VENDIDO (hoy / este mes), las cuatro tarjetas responden las
 * preguntas de siempre, y los recordatorios se calculan al entrar. TODAS las
 * cifras llegan de /v1/negocio/resumen: esta pantalla viste, no suma.
 */

interface Resumen {
  functional_currency: string;
  vendido_hoy: string;
  vendido_mes: string;
  ganado_hoy: string;
  ganado_mes: string;
  lineas_sin_costo_mes: number;
  lo_que_me_deben: string;
  lo_que_debo: string;
  mi_dinero: { currency: string; balance: string }[];
  por_agotarse: number;
  tasa_del_dia: { rate: string; rate_date: string; source: string; es_de_hoy: boolean } | null;
  ultimas_ventas: {
    id: string;
    issued_at: string | null;
    customer_name: string;
    total_functional: string;
    status: string;
  }[];
}

export function Inicio(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const navigate = useNavigate();
  const [ventana, setVentana] = useState<"hoy" | "mes">("hoy");

  const resumen = useQuery({
    queryKey: ["negocio-resumen", empresa.id],
    queryFn: () => llamar<Resumen>("/v1/negocio/resumen"),
  });
  const r = resumen.data ?? null;
  const moneda = r?.functional_currency ?? "VES";

  const recordatorios: { texto: string; a: string }[] = [];
  if (r !== null) {
    if (r.tasa_del_dia === null || !r.tasa_del_dia.es_de_hoy) {
      recordatorios.push({
        texto: "La tasa del día no está confirmada. Un toque en «Sigue igual» y listo.",
        a: "/dinero",
      });
    }
    if (r.por_agotarse > 0) {
      recordatorios.push({
        texto: `${r.por_agotarse} producto${r.por_agotarse === 1 ? "" : "s"} por agotarse. Revisa qué pedir.`,
        a: "/inventario",
      });
    }
    if (!esCero(r.lo_que_me_deben)) {
      recordatorios.push({
        texto: `Te deben ${mostrarImporte({ amount: r.lo_que_me_deben, currency: moneda })}. Un mensaje a tiempo cobra la mitad.`,
        a: "/clientes",
      });
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Inicio</h1>
        <Button variant="primary" size="lg" onClick={() => void navigate("/vender")}>
          <Store /> Vender
        </Button>
      </div>

      {/* El número grande: lo vendido, con su ventana. */}
      <Card>
        <CardContent className="py-6 text-center">
          <div className="mb-2 inline-flex rounded-full border border-border p-0.5">
            {(
              [
                ["hoy", "Hoy"],
                ["mes", "Este mes"],
              ] as const
            ).map(([clave, etiqueta]) => (
              <button
                key={clave}
                onClick={() => setVentana(clave)}
                className={`rounded-full px-3 py-1 text-[0.85rem] ${
                  ventana === clave
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {etiqueta}
              </button>
            ))}
          </div>
          <p className="text-[0.9rem] text-muted-foreground">
            {ventana === "hoy" ? "Vendido hoy" : "Vendido este mes"}
          </p>
          <p className="text-4xl font-semibold tabular-nums">
            {r !== null
              ? mostrarImporte({
                  amount: ventana === "hoy" ? r.vendido_hoy : r.vendido_mes,
                  currency: moneda,
                })
              : "…"}
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <TrendingUp className="size-4" />
              <span className="text-[0.85rem]">
                Lo que gané {ventana === "hoy" ? "hoy" : "este mes"}
              </span>
            </div>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {r !== null
                ? mostrarImporte({
                    amount: ventana === "hoy" ? r.ganado_hoy : r.ganado_mes,
                    currency: moneda,
                  })
                : "…"}
            </p>
            {r !== null && r.lineas_sin_costo_mes > 0 && (
              <p className="mt-0.5 text-[0.78rem] text-warning-soft-foreground">
                {r.lineas_sin_costo_mes} venta{r.lineas_sin_costo_mes === 1 ? "" : "s"} sin costo
                cargado: la ganancia real puede ser menor.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <ArrowDownToLine className="size-4" />
              <span className="text-[0.85rem]">Lo que me deben</span>
            </div>
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {r !== null ? mostrarImporte({ amount: r.lo_que_me_deben, currency: moneda }) : "…"}
            </p>
            <Link
              to="/clientes"
              className="text-[0.8rem] text-accent-soft-foreground hover:underline"
            >
              Ver quién
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Wallet className="size-4" />
              <span className="text-[0.85rem]">Mi dinero</span>
            </div>
            {r !== null && r.mi_dinero.length > 0 ? (
              r.mi_dinero.map((m) => (
                <p
                  key={m.currency}
                  className="mt-0.5 text-lg font-semibold leading-tight tabular-nums"
                >
                  {mostrarImporte({ amount: m.balance, currency: m.currency })}
                </p>
              ))
            ) : (
              <p className="mt-1 text-[0.85rem] text-muted-foreground">Sin cuentas todavía</p>
            )}
            <Link
              to="/dinero"
              className="text-[0.8rem] text-accent-soft-foreground hover:underline"
            >
              Ver cuentas
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <TriangleAlert className="size-4" />
              <span className="text-[0.85rem]">Por agotarse</span>
            </div>
            <p className="mt-1 text-xl font-semibold tabular-nums">{r?.por_agotarse ?? "…"}</p>
            <Link
              to="/inventario"
              className="text-[0.8rem] text-accent-soft-foreground hover:underline"
            >
              Ver cuáles
            </Link>
          </CardContent>
        </Card>
      </div>

      {recordatorios.length > 0 && (
        <div className="space-y-2">
          {recordatorios.map((rec) => (
            <Link
              key={rec.a + rec.texto}
              to={rec.a}
              className="flex items-center gap-2.5 rounded-md border border-border bg-surface px-3 py-2.5 text-[0.9rem] hover:border-accent"
            >
              <RefreshCw className="size-4 shrink-0 text-accent" />
              {rec.texto}
            </Link>
          ))}
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-[1.05rem] font-semibold">Últimas ventas</h2>
        {r !== null && r.ultimas_ventas.length === 0 ? (
          <Card className="py-10 text-center">
            <Store className="mx-auto size-8 text-faint-foreground" />
            <p className="mt-2 font-medium">Todavía no has vendido</p>
            <p className="mt-1 text-[0.9rem] text-muted-foreground">
              Cuando hagas tu primera venta, aquí la verás.
            </p>
            <Button variant="primary" className="mt-4" onClick={() => void navigate("/vender")}>
              <Store /> Hacer la primera venta
            </Button>
          </Card>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border bg-surface">
            {(r?.ultimas_ventas ?? []).map((v) => (
              <div key={v.id} className="flex items-center gap-3 px-3 py-2.5 text-[0.9rem]">
                <span className="w-20 shrink-0 text-[0.82rem] text-muted-foreground">
                  {v.issued_at !== null ? fechaRelativa(v.issued_at) : "—"}
                </span>
                <span className="min-w-0 flex-1 truncate">{v.customer_name}</span>
                {v.status === "annulled" && (
                  <span className="rounded-full bg-destructive-soft px-2 py-0.5 text-[0.72rem] text-destructive-soft-foreground">
                    Anulada
                  </span>
                )}
                <span className="shrink-0 font-medium tabular-nums">
                  {mostrarImporte({ amount: v.total_functional, currency: moneda })}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {r?.tasa_del_dia !== null && r?.tasa_del_dia !== undefined && (
        <p className="text-center text-[0.82rem] text-faint-foreground tabular-nums">
          Tasa del día: Bs. {mostrarCantidad(r.tasa_del_dia.rate)} por dólar ·{" "}
          {r.tasa_del_dia.source}
        </p>
      )}
    </div>
  );
}
