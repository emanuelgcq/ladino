import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  api,
  LlamadaApiError,
  type Account,
  type AccountPurposeRow,
  type BalanceSheet,
  type ChartTemplate,
  type FiscalPeriod,
  type IncomeStatement,
  type JournalEntry,
  type JournalEntryDetail,
  type LedgerView,
  type PendingJournal,
  type TrialBalance,
} from "./lib.js";
import { mostrarImporte } from "./money.js";

/**
 * Contabilidad. La pantalla NO calcula NADA: ni un saldo, ni un total del
 * balance, ni si el estado de situación cuadra. Todo llega calculado por el
 * esquema, en moneda funcional.
 *
 * La ÚNICA excepción es el asiento manual, que muestra si cuadra mientras se
 * teclea — y está dicho ahí por qué es una excepción legítima: no persiste
 * nada, no decide nada, y el servidor lo rechaza igual. Es ayuda para escribir,
 * no una segunda contabilidad.
 */
function mensajeDe(e: unknown): string {
  return e instanceof LlamadaApiError ? `${e.body.code}: ${e.body.message}` : String(e);
}

interface Props {
  session: Session;
  companyId: string;
}

function idem(): Record<string, string> {
  return { "Idempotency-Key": crypto.randomUUID() };
}

const HOY = (): string => new Date().toISOString().slice(0, 10);

export function AccountingView({ session, companyId }: Props) {
  const [panel, setPanel] = useState<
    "plan" | "diario" | "nuevo" | "mayor" | "balance" | "cierre" | "estados"
  >("plan");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");

  return (
    <section>
      <h2>Contabilidad</h2>
      <nav>
        {(
          [
            ["plan", "Plan de cuentas"],
            ["diario", "Diario"],
            ["nuevo", "Asiento manual"],
            ["mayor", "Mayor"],
            ["balance", "Comprobación"],
            ["cierre", "Cierre"],
            ["estados", "Estados financieros"],
          ] as const
        ).map(([k, etiqueta]) => (
          <span key={k}>
            <button disabled={panel === k} onClick={() => setPanel(k)}>
              {etiqueta}
            </button>{" "}
          </span>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      {aviso && <p role="status">{aviso}</p>}

      {panel === "plan" ? (
        <PlanDeCuentas
          session={session}
          companyId={companyId}
          onError={setError}
          onAviso={setAviso}
        />
      ) : panel === "diario" ? (
        <Diario session={session} companyId={companyId} onError={setError} onAviso={setAviso} />
      ) : panel === "nuevo" ? (
        <AsientoManual
          session={session}
          companyId={companyId}
          onError={setError}
          onHecho={(m) => {
            setAviso(m);
            setPanel("diario");
          }}
        />
      ) : panel === "mayor" ? (
        <Mayor session={session} companyId={companyId} onError={setError} />
      ) : panel === "balance" ? (
        <Comprobacion session={session} companyId={companyId} onError={setError} />
      ) : panel === "cierre" ? (
        <Cierre session={session} companyId={companyId} onError={setError} onAviso={setAviso} />
      ) : (
        <Estados session={session} companyId={companyId} onError={setError} />
      )}
    </section>
  );
}

// ── Plan de cuentas ─────────────────────────────────────────────────────────

function PlanDeCuentas({
  session,
  companyId,
  onError,
  onAviso,
}: Props & { onError: (m: string) => void; onAviso: (m: string) => void }): React.JSX.Element {
  const [cuentas, setCuentas] = useState<Account[] | null>(null);
  const [plantillas, setPlantillas] = useState<ChartTemplate[]>([]);
  const [papeles, setPapeles] = useState<AccountPurposeRow[]>([]);
  const [alta, setAlta] = useState({ code: "", name: "", kind: "activo", parent_id: "" });

  const cargar = useCallback(async () => {
    try {
      const [cs, ts, ps] = await Promise.all([
        api<Account[]>(session, "/v1/accounts", { companyId }),
        api<ChartTemplate[]>(session, "/v1/chart-templates", { companyId }),
        api<AccountPurposeRow[]>(session, "/v1/company-account-settings", { companyId }),
      ]);
      setCuentas(cs);
      setPlantillas(ts);
      setPapeles(ps);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }, [session, companyId, onError]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function importar(code: string) {
    if (
      !window.confirm(
        "Importar copia las cuentas de la plantilla a tu plan y las DESLIGA: a partir de ahí son tuyas y las editas tú. La plantilla está marcada VALIDAR-CONTABLE — no es un plan correcto para ninguna empresa concreta hasta que tu contador lo revise. ¿Importar?",
      )
    ) {
      return;
    }
    try {
      const r = await api<{ imported: number; purposes: number }>(
        session,
        "/v1/accounts/import-template",
        {
          method: "POST",
          companyId,
          headers: idem(),
          body: JSON.stringify({ company_id: companyId, template_code: code }),
        },
      );
      onAviso(`Importadas ${r.imported} cuentas y ${r.purposes} papeles contables.`);
      await cargar();
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  async function crear() {
    try {
      await api(session, "/v1/accounts", {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify({
          company_id: companyId,
          code: alta.code,
          name: alta.name,
          kind: alta.kind,
          ...(alta.parent_id ? { parent_id: alta.parent_id } : {}),
        }),
      });
      setAlta({ code: "", name: "", kind: "activo", parent_id: "" });
      await cargar();
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  async function desactivar(id: string) {
    if (!window.confirm("Desactivar no borra el histórico: los asientos anteriores siguen ahí."))
      return;
    try {
      await api(session, `/v1/accounts/${id}/deactivate`, {
        method: "POST",
        companyId,
        headers: idem(),
      });
      await cargar();
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  const sinAsignar = papeles.filter((p) => p.account_id === null);

  return (
    <>
      <h3>Plan de cuentas</h3>
      {cuentas === null ? (
        <p>cargando…</p>
      ) : cuentas.length === 0 ? (
        <>
          <p>
            El plan nace <strong>vacío</strong>: el plan de cuentas no se puede dar por supuesto, lo
            decide tu contador. Crea las cuentas a mano o importa una plantilla como punto de
            partida.
          </p>
          <ul>
            {plantillas.map((t) => (
              <li key={t.code}>
                <strong>{t.name}</strong> ({t.account_count} cuentas, {t.framework})
                <br />
                {/* El marcado VALIDAR-CONTABLE se muestra ENTERO, sin recortar:
                    es la advertencia que evita que la plantilla se adopte sin
                    revisar. */}
                <small>{t.description}</small>
                <br />
                <small>Fuente: {t.legal_source}</small>
                <br />
                <button onClick={() => void importar(t.code)}>Importar esta plantilla</button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Código</th>
              <th>Nombre</th>
              <th>Tipo</th>
              <th>Naturaleza</th>
              <th>Recibe asientos</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cuentas.map((a) => (
              <tr key={a.id} style={{ opacity: a.is_active ? 1 : 0.5 }}>
                <td style={{ paddingLeft: `${(a.level - 1) * 16}px` }}>{a.code}</td>
                <td>{a.name}</td>
                <td>{a.kind}</td>
                <td>{a.nature}</td>
                {/* Una cuenta que agrupa NO recibe asientos: decirlo aquí evita
                    el 409 al postear. */}
                <td>{a.is_leaf ? (a.is_active ? "sí" : "desactivada") : "no (agrupa)"}</td>
                <td>
                  {a.is_active && <button onClick={() => void desactivar(a.id)}>desactivar</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <fieldset>
        <legend>Crear cuenta</legend>
        <input
          placeholder="código"
          value={alta.code}
          onChange={(e) => setAlta({ ...alta, code: e.target.value })}
          size={10}
        />{" "}
        <input
          placeholder="nombre"
          value={alta.name}
          onChange={(e) => setAlta({ ...alta, name: e.target.value })}
          size={30}
        />{" "}
        <select value={alta.kind} onChange={(e) => setAlta({ ...alta, kind: e.target.value })}>
          {["activo", "pasivo", "patrimonio", "ingreso", "gasto", "orden"].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>{" "}
        <select
          value={alta.parent_id}
          onChange={(e) => setAlta({ ...alta, parent_id: e.target.value })}
        >
          <option value="">sin padre (raíz)</option>
          {(cuentas ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} — {a.name}
            </option>
          ))}
        </select>{" "}
        <button onClick={() => void crear()}>Crear</button>
        <p>
          <small>
            La naturaleza la impone el tipo: activo y gasto son deudoras; pasivo, patrimonio e
            ingreso, acreedoras.
          </small>
        </p>
      </fieldset>

      <h3>Papeles contables</h3>
      {sinAsignar.length > 0 && (
        <p role="alert">
          {sinAsignar.length} papel(es) sin cuenta asignada. Cada uno que falte impide generar el
          asiento automático que lo usa.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Papel</th>
            <th>Cuenta</th>
          </tr>
        </thead>
        <tbody>
          {papeles.map((p) => (
            <tr key={p.purpose}>
              <td title={p.description}>{p.name}</td>
              <td>
                {p.account_code === null ? (
                  <em>sin asignar</em>
                ) : (
                  `${p.account_code} — ${p.account_name ?? ""}`
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// ── Diario ──────────────────────────────────────────────────────────────────

function Diario({
  session,
  companyId,
  onError,
  onAviso,
}: Props & { onError: (m: string) => void; onAviso: (m: string) => void }): React.JSX.Element {
  const [asientos, setAsientos] = useState<JournalEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [abierto, setAbierto] = useState<JournalEntryDetail | null>(null);

  const cargar = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      if (status) q.set("status", status);
      if (desde) q.set("from", desde);
      if (hasta) q.set("to", hasta);
      const r = await api<{ items: JournalEntry[]; total: number }>(
        session,
        `/v1/journal-entries?${q.toString()}`,
        { companyId },
      );
      setAsientos(r.items);
      setTotal(r.total);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }, [session, companyId, status, desde, hasta, onError]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function abrir(id: string) {
    try {
      setAbierto(
        await api<JournalEntryDetail>(session, `/v1/journal-entries/${id}`, { companyId }),
      );
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  async function postear(id: string) {
    if (
      !window.confirm(
        "Postear hace el asiento INMUTABLE y lo lleva al mayor. A partir de ahí solo se corrige con un contra-asiento de reversión, y los dos quedan visibles. ¿Postear?",
      )
    ) {
      return;
    }
    try {
      await api(session, `/v1/journal-entries/${id}/post`, {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify({ company_id: companyId }),
      });
      onAviso("Asiento posteado.");
      await cargar();
      await abrir(id);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  async function reversar(id: string) {
    const motivo = window.prompt("Motivo de la reversión (queda en auditoría):");
    if (motivo === null || motivo.trim().length < 3) return;
    try {
      await api(session, `/v1/journal-entries/${id}/reverse`, {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify({ company_id: companyId, reason: motivo.trim() }),
      });
      onAviso("Contra-asiento posteado. Los dos quedan visibles y el neto por cuenta es cero.");
      await cargar();
      await abrir(id);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <>
      <h3>Diario ({total})</h3>
      <label>
        Estado{" "}
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">todos</option>
          <option value="draft">borrador</option>
          <option value="posted">posteado</option>
          <option value="reversed">reversado</option>
        </select>
      </label>{" "}
      <label>
        Desde <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
      </label>{" "}
      <label>
        Hasta <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
      </label>
      {asientos === null ? (
        <p>cargando…</p>
      ) : asientos.length === 0 ? (
        <p>No hay asientos con esos filtros.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Nº</th>
              <th>Fecha</th>
              <th>Descripción</th>
              <th>Origen</th>
              <th>Estado</th>
              <th>Débitos</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {asientos.map((e) => (
              <tr key={e.id}>
                <td>{e.entry_number ?? "—"}</td>
                <td>{e.posting_date}</td>
                <td>{e.description}</td>
                <td>{e.source_kind}</td>
                <td>{e.status}</td>
                <td>{e.total_debit}</td>
                <td>
                  <button onClick={() => void abrir(e.id)}>ver</button>{" "}
                  {e.status === "draft" && (
                    <button onClick={() => void postear(e.id)}>postear</button>
                  )}
                  {e.status === "posted" && (
                    <button onClick={() => void reversar(e.id)}>reversar</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {abierto && (
        <article>
          <h4>
            Asiento {abierto.entry.entry_number ?? "(borrador)"} — {abierto.entry.description}{" "}
            <button onClick={() => setAbierto(null)}>cerrar</button>
          </h4>
          <p>
            {abierto.entry.posting_date} · {abierto.entry.status}
            {abierto.entry.is_reversal_of !== null && " · es la reversión de otro asiento"}
            {abierto.entry.reversed_by_entry_id !== null && " · reversado por otro asiento"}
            {abierto.entry.source_id !== null &&
              ` · origen: ${abierto.entry.source_kind} (${abierto.entry.source_event ?? ""})`}
          </p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Cuenta</th>
                <th>Débito</th>
                <th>Crédito</th>
                <th>Dimensiones</th>
              </tr>
            </thead>
            <tbody>
              {abierto.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.line_number}</td>
                  <td>
                    {l.account_code} — {l.account_name}
                  </td>
                  <td>
                    {l.functional_debit === "0.00000000"
                      ? ""
                      : mostrarImporte({
                          amount: l.functional_debit,
                          currency: l.functional_currency,
                        })}
                  </td>
                  <td>
                    {l.functional_credit === "0.00000000"
                      ? ""
                      : mostrarImporte({
                          amount: l.functional_credit,
                          currency: l.functional_currency,
                        })}
                  </td>
                  <td>
                    {l.analytical_dimensions === null
                      ? ""
                      : Object.entries(l.analytical_dimensions)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            {/* Los totales llegan del servidor. Sumar aquí sería una segunda
                contabilidad que un día diferiría de la primera. */}
            Débitos <strong>{abierto.entry.total_debit}</strong> · Créditos{" "}
            <strong>{abierto.entry.total_credit}</strong>
          </p>
        </article>
      )}
    </>
  );
}

// ── Asiento manual ──────────────────────────────────────────────────────────

interface LineaBorrador {
  account_id: string;
  side: "debit" | "credit";
  amount: string;
  description: string;
}

function AsientoManual({
  session,
  companyId,
  onError,
  onHecho,
}: Props & { onError: (m: string) => void; onHecho: (m: string) => void }): React.JSX.Element {
  const [cuentas, setCuentas] = useState<Account[]>([]);
  const [fecha, setFecha] = useState(HOY());
  const [descripcion, setDescripcion] = useState("");
  const [lineas, setLineas] = useState<LineaBorrador[]>([
    { account_id: "", side: "debit", amount: "", description: "" },
    { account_id: "", side: "credit", amount: "", description: "" },
  ]);

  useEffect(() => {
    api<Account[]>(session, "/v1/accounts?leaves_only=true", { companyId })
      .then(setCuentas)
      .catch((e: unknown) => onError(mensajeDe(e)));
  }, [session, companyId, onError]);

  /**
   * El único cálculo del cliente en todo el módulo, y es legítimo: no persiste
   * nada, no decide nada y el servidor lo rechaza igual con un trigger. Sirve
   * para no enviar un asiento que se sabe descuadrado. Se compara sobre enteros
   * de céntimos para no arrastrar el error de coma flotante en la comparación.
   */
  const centimos = (s: string): number => {
    const n = Number.parseFloat(s.trim() === "" ? "0" : s);
    return Number.isFinite(n) ? Math.round(n * 100) : Number.NaN;
  };
  const debitos = lineas
    .filter((l) => l.side === "debit")
    .reduce((acc, l) => acc + centimos(l.amount), 0);
  const creditos = lineas
    .filter((l) => l.side === "credit")
    .reduce((acc, l) => acc + centimos(l.amount), 0);
  const cuadra =
    Number.isFinite(debitos) && Number.isFinite(creditos) && debitos === creditos && debitos > 0;
  const completo =
    lineas.every((l) => l.account_id !== "" && l.amount.trim() !== "") &&
    descripcion.trim().length >= 3;

  async function guardar() {
    try {
      const r = await api<JournalEntry>(session, "/v1/journal-entries", {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify({
          company_id: companyId,
          posting_date: fecha,
          description: descripcion.trim(),
          lines: lineas.map((l) => ({
            account_id: l.account_id,
            ...(l.side === "debit" ? { debit: l.amount } : { credit: l.amount }),
            ...(l.description ? { description: l.description } : {}),
          })),
        }),
      });
      onHecho(`Asiento creado en borrador (${r.id.slice(0, 8)}). Postéalo desde el diario.`);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <>
      <h3>Asiento manual</h3>
      <p>
        Se crea en <strong>borrador</strong>. Postear es un acto aparte, con su propio permiso,
        porque es el que lo hace inmutable.
      </p>
      <label>
        Fecha <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
      </label>{" "}
      <label>
        Descripción{" "}
        <input
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          size={50}
          placeholder="qué documenta este asiento"
        />
      </label>
      <table>
        <thead>
          <tr>
            <th>Cuenta</th>
            <th>Lado</th>
            <th>Importe</th>
            <th>Detalle</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lineas.map((l, i) => (
            <tr key={i}>
              <td>
                <select
                  value={l.account_id}
                  onChange={(e) => {
                    const cp = [...lineas];
                    cp[i] = { ...l, account_id: e.target.value };
                    setLineas(cp);
                  }}
                >
                  <option value="">cuenta…</option>
                  {cuentas.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select
                  value={l.side}
                  onChange={(e) => {
                    const cp = [...lineas];
                    cp[i] = { ...l, side: e.target.value as "debit" | "credit" };
                    setLineas(cp);
                  }}
                >
                  <option value="debit">débito</option>
                  <option value="credit">crédito</option>
                </select>
              </td>
              <td>
                <input
                  value={l.amount}
                  onChange={(e) => {
                    const cp = [...lineas];
                    cp[i] = { ...l, amount: e.target.value };
                    setLineas(cp);
                  }}
                  size={12}
                />
              </td>
              <td>
                <input
                  value={l.description}
                  onChange={(e) => {
                    const cp = [...lineas];
                    cp[i] = { ...l, description: e.target.value };
                    setLineas(cp);
                  }}
                  size={20}
                />
              </td>
              <td>
                {lineas.length > 2 && (
                  <button onClick={() => setLineas(lineas.filter((_, j) => j !== i))}>
                    quitar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        onClick={() =>
          setLineas([...lineas, { account_id: "", side: "debit", amount: "", description: "" }])
        }
      >
        Añadir línea
      </button>
      <p role="status">
        {cuadra ? (
          <strong>Cuadra.</strong>
        ) : (
          <>
            <strong>No cuadra todavía.</strong> Débitos {(debitos / 100).toFixed(2)} contra créditos{" "}
            {(creditos / 100).toFixed(2)}.
          </>
        )}{" "}
        <small>
          Esta comprobación es ayuda para escribir, no la que manda: el servidor la repite con un
          trigger y rechaza igual.
        </small>
      </p>
      <button disabled={!cuadra || !completo} onClick={() => void guardar()}>
        Guardar borrador
      </button>
    </>
  );
}

// ── Mayor ───────────────────────────────────────────────────────────────────

function Mayor({
  session,
  companyId,
  onError,
}: Props & { onError: (m: string) => void }): React.JSX.Element {
  const [cuentas, setCuentas] = useState<Account[]>([]);
  const [cuentaId, setCuentaId] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState(HOY());
  const [mayor, setMayor] = useState<LedgerView | null>(null);

  useEffect(() => {
    api<Account[]>(session, "/v1/accounts?leaves_only=true", { companyId })
      .then(setCuentas)
      .catch((e: unknown) => onError(mensajeDe(e)));
  }, [session, companyId, onError]);

  async function consultar() {
    if (cuentaId === "") return;
    try {
      const q = new URLSearchParams({ account: cuentaId, to: hasta });
      if (desde) q.set("from", desde);
      setMayor(await api<LedgerView>(session, `/v1/ledger?${q.toString()}`, { companyId }));
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <>
      <h3>Mayor de cuenta</h3>
      <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)}>
        <option value="">elige cuenta…</option>
        {cuentas.map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} — {a.name}
          </option>
        ))}
      </select>{" "}
      <label>
        Desde <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
      </label>{" "}
      <label>
        Hasta <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
      </label>{" "}
      <button onClick={() => void consultar()}>Consultar</button>
      {mayor && (
        <>
          <h4>
            {mayor.account_code} — {mayor.account_name} ({mayor.nature})
          </h4>
          <p>
            Saldo inicial:{" "}
            <strong>
              {mostrarImporte({ amount: mayor.opening_balance, currency: mayor.currency })}
            </strong>{" "}
            · Saldo final:{" "}
            <strong>
              {mostrarImporte({ amount: mayor.closing_balance, currency: mayor.currency })}
            </strong>
          </p>
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Nº</th>
                <th>Descripción</th>
                <th>Débito</th>
                <th>Crédito</th>
                <th>Origen</th>
              </tr>
            </thead>
            <tbody>
              {mayor.movements.map((m, i) => (
                <tr key={`${m.entry_id}-${i}`}>
                  <td>{m.posting_date}</td>
                  <td>{m.entry_number ?? "—"}</td>
                  <td>{m.description}</td>
                  <td>
                    {m.debit === "0.00000000"
                      ? ""
                      : mostrarImporte({ amount: m.debit, currency: mayor.currency })}
                  </td>
                  <td>
                    {m.credit === "0.00000000"
                      ? ""
                      : mostrarImporte({ amount: m.credit, currency: mayor.currency })}
                  </td>
                  <td>{m.source_kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

// ── Balance de comprobación ─────────────────────────────────────────────────

function Comprobacion({
  session,
  companyId,
  onError,
}: Props & { onError: (m: string) => void }): React.JSX.Element {
  const [fecha, setFecha] = useState(HOY());
  const [desde, setDesde] = useState("");
  const [balance, setBalance] = useState<TrialBalance | null>(null);

  async function consultar() {
    try {
      const q = new URLSearchParams({ date: fecha });
      if (desde) q.set("from", desde);
      setBalance(
        await api<TrialBalance>(session, `/v1/trial-balance?${q.toString()}`, { companyId }),
      );
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <>
      <h3>Balance de comprobación</h3>
      <label>
        Desde <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
      </label>{" "}
      <label>
        A fecha <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
      </label>{" "}
      <button onClick={() => void consultar()}>Generar</button>
      {balance && (
        <>
          {/* Si esto sale en rojo, hay un asiento roto en la base. No es un
              aviso de la pantalla: lo dice el servidor. */}
          {!balance.balanced && (
            <p role="alert">
              El balance NO cuadra: débitos {balance.total_debit} contra créditos{" "}
              {balance.total_credit}. Eso significa un asiento roto en la base, no un error de esta
              pantalla.
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Código</th>
                <th>Cuenta</th>
                <th>Saldo inicial</th>
                <th>Débitos</th>
                <th>Créditos</th>
                <th>Saldo final</th>
                <th>Naturaleza</th>
              </tr>
            </thead>
            <tbody>
              {balance.rows.map((r) => (
                <tr key={r.account_id}>
                  <td>{r.account_code}</td>
                  <td>{r.account_name}</td>
                  <td>
                    {mostrarImporte({ amount: r.opening_balance, currency: balance.currency })}
                  </td>
                  <td>{mostrarImporte({ amount: r.period_debit, currency: balance.currency })}</td>
                  <td>{mostrarImporte({ amount: r.period_credit, currency: balance.currency })}</td>
                  <td>
                    {mostrarImporte({ amount: r.closing_balance, currency: balance.currency })}
                  </td>
                  <td>{r.nature}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={3}>Totales</th>
                <th>
                  {mostrarImporte({ amount: balance.total_debit, currency: balance.currency })}
                </th>
                <th>
                  {mostrarImporte({ amount: balance.total_credit, currency: balance.currency })}
                </th>
                <th colSpan={2}>{balance.balanced ? "cuadra" : "NO CUADRA"}</th>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </>
  );
}

// ── Cierre ──────────────────────────────────────────────────────────────────

function Cierre({
  session,
  companyId,
  onError,
  onAviso,
}: Props & { onError: (m: string) => void; onAviso: (m: string) => void }): React.JSX.Element {
  const [periodos, setPeriodos] = useState<FiscalPeriod[] | null>(null);
  const [pendientes, setPendientes] = useState<PendingJournal | null>(null);
  const [anio, setAnio] = useState(new Date().getFullYear());

  const cargar = useCallback(async () => {
    try {
      const [ps, pend] = await Promise.all([
        api<FiscalPeriod[]>(session, "/v1/fiscal-periods", { companyId }),
        api<PendingJournal>(session, "/v1/accounting/pending", { companyId }),
      ]);
      setPeriodos(ps);
      setPendientes(pend);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }, [session, companyId, onError]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function cerrar(id: string, p: FiscalPeriod) {
    if (
      !window.confirm(
        `Cerrar ${p.year}-${String(p.month).padStart(2, "0")} impide cualquier asiento con fecha en ese mes. Reabrirlo después exige un permiso propio y un motivo escrito que queda en auditoría. ¿Cerrar?`,
      )
    ) {
      return;
    }
    try {
      await api(session, `/v1/fiscal-periods/${id}/close`, {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify({ company_id: companyId }),
      });
      onAviso("Período cerrado.");
      await cargar();
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  async function reabrir(id: string) {
    const motivo = window.prompt(
      "Motivo de la reapertura (mínimo 10 caracteres; queda en el período y en auditoría):",
    );
    if (motivo === null || motivo.trim().length < 10) return;
    try {
      await api(session, `/v1/fiscal-periods/${id}/reopen`, {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify({ company_id: companyId, reason: motivo.trim() }),
      });
      onAviso("Período reabierto, con su motivo registrado.");
      await cargar();
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  async function cierreAnual() {
    if (
      !window.confirm(
        `El cierre de ${anio} lleva ingresos y gastos a Resultado del ejercicio y el resultado a Utilidades acumuladas, con un asiento posteado. Exige que esas dos cuentas estén configuradas. ¿Ejecutar?`,
      )
    ) {
      return;
    }
    try {
      const r = await api<JournalEntry>(session, "/v1/fiscal-periods/year-end-close", {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify({ company_id: companyId, year: anio }),
      });
      onAviso(`Cierre anual posteado como asiento ${r.entry_number ?? ""}.`);
      await cargar();
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <>
      <h3>Cierre de período</h3>
      {pendientes !== null && pendientes.total > 0 && (
        // La cola es lo que ADR-0042 pone delante del cierre: una cola que
        // nadie mira es una contabilidad que no existe.
        <p role="alert">
          Hay <strong>{pendientes.total}</strong> documento(s) pendientes de contabilizar. Ningún
          período se cierra mientras queden: sería contabilidad que falta y que ya nadie va a poder
          asentar en su fecha.
        </p>
      )}
      {periodos === null ? (
        <p>cargando…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Período</th>
              <th>Estado</th>
              <th>Borradores</th>
              <th>Motivo de reapertura</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {periodos.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.year}-{String(p.month).padStart(2, "0")}
                </td>
                <td>{p.status}</td>
                <td>{p.draft_entry_count}</td>
                <td>{p.reopened_reason ?? ""}</td>
                <td>
                  {p.status !== "closed" ? (
                    <button
                      disabled={p.draft_entry_count > 0 || (pendientes?.total ?? 0) > 0}
                      onClick={() => void cerrar(p.id, p)}
                    >
                      cerrar
                    </button>
                  ) : (
                    <button onClick={() => void reabrir(p.id)}>reabrir</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pendientes !== null && pendientes.items.length > 0 && (
        <>
          <h4>Pendientes de contabilizar</h4>
          <ul>
            {pendientes.items.map((i) => (
              <li key={i.id}>
                {i.source_kind} · {i.source_event} · {i.reason}
              </li>
            ))}
          </ul>
        </>
      )}

      <fieldset>
        <legend>Cierre anual</legend>
        <input
          type="number"
          value={anio}
          onChange={(e) => setAnio(Number(e.target.value))}
          size={6}
        />{" "}
        <button onClick={() => void cierreAnual()}>Ejecutar cierre de ejercicio</button>
      </fieldset>
    </>
  );
}

// ── Estados financieros ─────────────────────────────────────────────────────

function Estados({
  session,
  companyId,
  onError,
}: Props & { onError: (m: string) => void }): React.JSX.Element {
  const [desde, setDesde] = useState(`${new Date().getFullYear()}-01-01`);
  const [hasta, setHasta] = useState(HOY());
  const [resultados, setResultados] = useState<IncomeStatement | null>(null);
  const [situacion, setSituacion] = useState<BalanceSheet | null>(null);

  async function generar() {
    try {
      const [r, b] = await Promise.all([
        api<IncomeStatement>(
          session,
          `/v1/accounting/reports/income-statement?from=${desde}&to=${hasta}`,
          { companyId },
        ),
        api<BalanceSheet>(session, `/v1/accounting/reports/balance-sheet?date=${hasta}`, {
          companyId,
        }),
      ]);
      setResultados(r);
      setSituacion(b);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <>
      <h3>Estados financieros</h3>
      <label>
        Desde <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
      </label>{" "}
      <label>
        Hasta <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
      </label>{" "}
      <button onClick={() => void generar()}>Generar</button>
      {resultados && (
        <>
          <h4>
            Estado de resultados · {resultados.from_date} a {resultados.to_date}
          </h4>
          <table>
            <tbody>
              {resultados.income.map((f) => (
                <tr key={f.account_code}>
                  <td>{f.account_code}</td>
                  <td>{f.account_name}</td>
                  <td>{mostrarImporte({ amount: f.amount, currency: resultados.currency })}</td>
                </tr>
              ))}
              <tr>
                <th colSpan={2}>Total ingresos</th>
                <th>
                  {mostrarImporte({
                    amount: resultados.total_income,
                    currency: resultados.currency,
                  })}
                </th>
              </tr>
              {resultados.expenses.map((f) => (
                <tr key={f.account_code}>
                  <td>{f.account_code}</td>
                  <td>{f.account_name}</td>
                  <td>{mostrarImporte({ amount: f.amount, currency: resultados.currency })}</td>
                </tr>
              ))}
              <tr>
                <th colSpan={2}>Total gastos</th>
                <th>
                  {mostrarImporte({
                    amount: resultados.total_expenses,
                    currency: resultados.currency,
                  })}
                </th>
              </tr>
              <tr>
                <th colSpan={2}>Resultado</th>
                <th>
                  {mostrarImporte({ amount: resultados.result, currency: resultados.currency })}
                </th>
              </tr>
            </tbody>
          </table>
        </>
      )}
      {situacion && (
        <>
          <h4>Balance general al {situacion.as_of}</h4>
          {!situacion.balanced && (
            <p role="alert">
              Activo ≠ pasivo + patrimonio. Eso es un asiento roto en la base, no un problema de
              esta pantalla.
            </p>
          )}
          <table>
            <tbody>
              <tr>
                <th colSpan={3}>Activo</th>
              </tr>
              {situacion.assets.map((f) => (
                <tr key={f.account_code}>
                  <td>{f.account_code}</td>
                  <td>{f.account_name}</td>
                  <td>{mostrarImporte({ amount: f.amount, currency: situacion.currency })}</td>
                </tr>
              ))}
              <tr>
                <th colSpan={2}>Total activo</th>
                <th>
                  {mostrarImporte({ amount: situacion.total_assets, currency: situacion.currency })}
                </th>
              </tr>
              <tr>
                <th colSpan={3}>Pasivo</th>
              </tr>
              {situacion.liabilities.map((f) => (
                <tr key={f.account_code}>
                  <td>{f.account_code}</td>
                  <td>{f.account_name}</td>
                  <td>{mostrarImporte({ amount: f.amount, currency: situacion.currency })}</td>
                </tr>
              ))}
              <tr>
                <th colSpan={3}>Patrimonio</th>
              </tr>
              {situacion.equity.map((f) => (
                <tr key={f.account_code}>
                  <td>{f.account_code}</td>
                  <td>{f.account_name}</td>
                  <td>{mostrarImporte({ amount: f.amount, currency: situacion.currency })}</td>
                </tr>
              ))}
              <tr>
                <th colSpan={2}>Pasivo + patrimonio</th>
                <th>
                  {mostrarImporte({
                    amount: situacion.total_liabilities,
                    currency: situacion.currency,
                  })}{" "}
                  +{" "}
                  {mostrarImporte({
                    amount: situacion.total_equity,
                    currency: situacion.currency,
                  })}
                </th>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
