import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { createClient } from "@ladino/db";
import { asegurarTasaOficial } from "../src/tasa-oficial.js";

/**
 * El refresco automático de la tasa oficial, contra un mock de DolarAPI con
 * CONTADOR: lo que este archivo prueba es la orden del dueño — la tasa se
 * guarda en la base y NO se hacen miles de llamadas a la API. La base primero;
 * la fuente, a lo sumo una vez por día publicado.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const URL_API = "postgres://ladino_api:ladino_api@127.0.0.1:54322/postgres";

/** Tasa distintiva del mock: la limpieza borra por ella, no por fecha. */
const TASA_MOCK = "777.1752";

const diaCaracas = (desplazamientoDias = 0): string => {
  const d = new Date(Date.now() + desplazamientoDias * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Caracas" }).format(d);
};

const cuerpoMock = (dia: string): string => `{
  "moneda": "USD",
  "fuente": "oficial",
  "promedio": ${TASA_MOCK},
  "fechaActualizacion": "${dia}T00:00:00-04:00"
}`;

let sql: ReturnType<typeof createClient>; // postgres: fixtures y limpieza
let sqlApi: ReturnType<typeof createClient>; // ladino_api: el rol del refresco
let mock: Server;
let mockUrl = "";
let peticiones = 0;
let respuesta: { status: number; cuerpo: string };

const limpiar = async (): Promise<void> => {
  await sql`delete from public.exchange_rates
             where from_currency = 'USD' and to_currency = 'VES'
               and (rate = ${TASA_MOCK}
                    or rate_date = (now() at time zone 'America/Caracas')::date)`;
};

beforeAll(async () => {
  sql = createClient(URL_LOCAL);
  sqlApi = createClient(URL_API);
  respuesta = { status: 200, cuerpo: cuerpoMock(diaCaracas()) };
  mock = createServer((_req, res) => {
    peticiones += 1;
    res.writeHead(respuesta.status, { "Content-Type": "application/json" });
    res.end(respuesta.cuerpo);
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const dir = mock.address();
  if (dir === null || typeof dir === "string") throw new Error("mock sin puerto");
  mockUrl = `http://127.0.0.1:${dir.port}`;
  await limpiar();
});

afterAll(async () => {
  await limpiar();
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  await sql.end({ timeout: 5 });
  await sqlApi.end({ timeout: 5 });
});

describe("el refresco automático de la tasa oficial", () => {
  it("sin tasa de hoy: UNA llamada a la fuente y la fila queda global, con su fuente citada", async () => {
    const antes = peticiones;
    expect(await asegurarTasaOficial(sqlApi, { url: mockUrl })).toBe("guardada");
    expect(peticiones).toBe(antes + 1);

    const [fila] = await sql<{ rate: string; source: string; rate_date: string }[]>`
      select rate::text as rate, source, rate_date::text as rate_date
        from public.exchange_rates
       where from_currency = 'USD' and to_currency = 'VES' and rate = ${TASA_MOCK}`;
    expect(fila).toBeDefined();
    expect(fila!.rate).toBe("777.17520000");
    expect(fila!.rate_date).toBe(diaCaracas());
    expect(fila!.source).toContain("BCV oficial vía DolarAPI");
  });

  it("con la tasa ya guardada: CERO llamadas a la fuente — la base es la caché", async () => {
    const antes = peticiones;
    expect(await asegurarTasaOficial(sqlApi, { url: mockUrl })).toBe("ya_estaba");
    expect(await asegurarTasaOficial(sqlApi, { url: mockUrl })).toBe("ya_estaba");
    expect(peticiones).toBe(antes);
  });

  it("fin de semana: la fuente repite el día hábil anterior y NO se duplica la fila", async () => {
    await limpiar();
    respuesta = { status: 200, cuerpo: cuerpoMock(diaCaracas(-1)) };
    // Primer tick: la publicación de ayer no estaba — se guarda (recupera un
    // día perdido). Segundo tick: hoy sigue sin tasa, se vuelve a preguntar,
    // y el único por (par, fuente, día) dice «ya la tengo».
    expect(await asegurarTasaOficial(sqlApi, { url: mockUrl })).toBe("guardada");
    expect(await asegurarTasaOficial(sqlApi, { url: mockUrl })).toBe("publicacion_repetida");
    const [n] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.exchange_rates where rate = ${TASA_MOCK}`;
    expect(n!.n).toBe("1");
  });

  it("con la fuente caída: «sin_fuente», nada guardado y nada lanzado — el fallback manual sigue", async () => {
    await limpiar();
    respuesta = { status: 500, cuerpo: "boom" };
    expect(await asegurarTasaOficial(sqlApi, { url: mockUrl })).toBe("sin_fuente");
    const [n] = await sql<{ n: string }[]>`
      select count(*)::text as n from public.exchange_rates where rate = ${TASA_MOCK}`;
    expect(n!.n).toBe("0");
  });
});
