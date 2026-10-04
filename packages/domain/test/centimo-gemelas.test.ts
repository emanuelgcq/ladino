import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createClient } from "@ladino/db";
import { parseDecimal, toCents } from "@ladino/money";

/**
 * LAS GEMELAS DEL CÉNTIMO (ADR-0075 §7). `toCents` (TS, @ladino/money) y `platform.round_cents`
 * (SQL, migración 20261003140000) tienen que decir LO MISMO: el dominio redondea con una y los
 * libros y el oráculo del kardex con la otra. Nadie lo comprobaba. Aquí los mismos bordes pasan
 * por las dos, contra Postgres real: si una cambia de modo (half-even, truncar), este test cae.
 */
const URL_LOCAL = "postgres://postgres:postgres@127.0.0.1:54322/postgres";

const BORDES = [
  "0.005",
  "-0.005",
  "0.00499999",
  "-0.00499999",
  "0.015",
  "0.025",
  "1.005",
  "-1.005",
  "2.675",
  "-2.675",
  "2.665",
  "2.674999995",
  "10.004999995",
  "-10.004999995",
  "0",
  "0.00000001",
  "-0.00000001",
  "4211.0335",
  "-4211.0335",
  "9999999999999999.985",
  "123456789.994999999999",
];

let sql: ReturnType<typeof createClient>;
beforeAll(() => {
  sql = createClient(URL_LOCAL);
});
afterAll(async () => {
  await sql?.end();
});

describe("toCents (TS) y platform.round_cents (SQL) dicen lo mismo", () => {
  it.each(BORDES)("en %s", async (entrada) => {
    const d = parseDecimal(entrada);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const [fila] = await sql<{ v: string; iguales: boolean }[]>`
      select platform.round_cents(${entrada}::numeric)::text as v,
             platform.round_cents(${entrada}::numeric) = ${toCents(d.value).toFixed(2)}::numeric
               as iguales`;
    expect(fila!.iguales).toBe(true);
    // Y el texto, sin el signo del cero: «-0.00» y «0.00» son el mismo importe.
    expect(Number(fila!.v)).toBe(Number(toCents(d.value).toFixed(2)));
  });

  it("y la variante rota: half-even NO es lo que dicen las gemelas (2,665 y 0,025 lo delatan)", () => {
    // Si alguien cambiara toCents a HALF_EVEN, 0.025 daría 0.02 y 2.665 daría 2.66.
    const d1 = parseDecimal("0.025");
    const d2 = parseDecimal("2.665");
    expect(d1.ok && toCents(d1.value).toFixed(2)).toBe("0.03");
    expect(d2.ok && toCents(d2.value).toFixed(2)).toBe("2.67");
  });
});
