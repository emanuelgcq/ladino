/**
 * Llamadas a la API LOCAL como una persona del escenario (su propio token, nunca service_role).
 * Solo para lo que la interfaz no permite o para reproducir un hallazgo que un agente de solo
 * lectura dejó en SOSPECHA; cada uso se anota en el informe como «creado por API».
 */
import fs from "node:fs";
import { API } from "./lib.mjs";

const AUTH = process.env.RECORRIDO_AUTH ?? "http://127.0.0.1:54321/auth/v1";
/** La clave anon local: RECORRIDO_ANON, o el fichero de RECORRIDO_ANON_FILE. Se lee al usarla. */
function anon() {
  if (process.env.RECORRIDO_ANON) return process.env.RECORRIDO_ANON;
  const fichero = process.env.RECORRIDO_ANON_FILE;
  if (fichero && fs.existsSync(fichero)) return fs.readFileSync(fichero, "utf8").trim();
  throw new Error(
    "Falta la clave anon local: da RECORRIDO_ANON o RECORRIDO_ANON_FILE (npx supabase status).",
  );
}

export async function token(correo, clave) {
  const r = await fetch(`${AUTH}/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon(), "Content-Type": "application/json" },
    body: JSON.stringify({ email: correo, password: clave }),
  });
  const j = await r.json();
  if (!j.access_token)
    throw new Error(`sin token para ${correo}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token;
}

export async function llamar(tk, companyId, metodo, ruta, cuerpo) {
  const t0 = Date.now();
  const r = await fetch(`${API}${ruta}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${tk}`,
      "Content-Type": "application/json",
      ...(companyId ? { "X-Company-Id": companyId } : {}),
      ...(metodo !== "GET" ? { "Idempotency-Key": crypto.randomUUID() } : {}),
    },
    ...(cuerpo !== undefined ? { body: JSON.stringify(cuerpo) } : {}),
  });
  const texto = await r.text();
  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    json = texto;
  }
  return { status: r.status, ms: Date.now() - t0, json };
}
