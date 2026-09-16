import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mostrarTasa, nombreDeTasa, tasaLimpia } from "../src/tasa.js";

/**
 * LA TASA, LIMPIA (dueño, 2026-09-16): «Tasa BCV: 842,2067» y nada más. Solo existe la tasa del
 * BCV y ya no se escribe a mano (ADR-0064 §1).
 */
const RAIZ = fileURLToPath(new URL("../src", import.meta.url));
function pantallas(dir = RAIZ, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) pantallas(p, acc);
    else if (p.endsWith(".tsx")) acc.push(p);
  }
  return acc;
}

describe("la tasa limpia", () => {
  it("se lee «Tasa BCV: número», exacta, con miles y coma decimal", () => {
    expect(tasaLimpia("842.20670000")).toBe("Tasa BCV: 842,2067");
    expect(mostrarTasa("1234.56780000")).toBe("1.234,5678");
    expect(mostrarTasa("36.12345678")).toBe("36,12345678");
    expect(mostrarTasa("900.00000000")).toBe("900");
  });

  it("un documento viejo con tasa tecleada no se rotula BCV: «Tipo de cambio»", () => {
    expect(tasaLimpia("842.20670000", "BCV oficial vía DolarAPI (2026-09-15T00:00:00-04:00)")).toBe(
      "Tasa BCV: 842,2067",
    );
    expect(tasaLimpia("900.00000000", "Carga manual del negocio")).toBe("Tipo de cambio: 900");
    expect(nombreDeTasa("sin cambio, confirmada (antes: BCV oficial (x))")).toBe("Tasa BCV");
  });

  it("ninguna pantalla nombra el servicio de la tasa ni pinta su fuente cruda", () => {
    const culpables = pantallas().filter((p) => {
      const s = readFileSync(p, "utf8");
      // Un `value={source}` de formulario no pinta nada: se excluye.
      return /DolarAPI/i.test(s) || /(?<!=)\{\s*[\w.]*\b(rate_)?source\s*\}/.test(s);
    });
    expect(culpables).toEqual([]);
  });

  it("ninguna pantalla escribe una tasa a mano ni la «confirma»", () => {
    const culpables = pantallas().filter((p) => {
      const s = readFileSync(p, "utf8");
      return (
        /["'`]\/v1\/exchange-rates["'`]\s*,\s*\{\s*method:\s*"POST"/.test(s) ||
        s.includes("/v1/exchange-rates/keep")
      );
    });
    expect(culpables).toEqual([]);
  });
});
