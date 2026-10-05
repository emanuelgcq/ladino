import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PEDIDO_COMPUESTO_NO_RESERVA } from "../src/components/capa-fiscal/textos.js";

/**
 * I-04 (ola 5, tercera ronda; ADR-0084). Confirmar un pedido reserva la existencia de sus líneas,
 * salvo la de un producto que se arma con otros: no lleva existencia propia, y la de sus
 * ingredientes se comprueba al facturar. La confirmación del pedido lo dice. Test de fuente: el
 * aviso está DENTRO del diálogo que confirma y reserva.
 */
const fuente = readFileSync(
  fileURLToPath(new URL("../src/pages/ventas/DetalleFactura.tsx", import.meta.url)),
  "utf8",
);

describe("la confirmación del pedido dice que un compuesto no se reserva", () => {
  it("el texto", () => {
    expect(PEDIDO_COMPUESTO_NO_RESERVA).toBe(
      "Los productos que se arman con otros no se reservan: su existencia se comprueba al facturar.",
    );
  });

  it("va dentro del diálogo «Confirmar el pedido»", () => {
    const dialogo = /<ConfirmDialog[^>]*title="Confirmar el pedido"[\s\S]*?<\/ConfirmDialog>/.exec(
      fuente,
    );
    expect(dialogo).not.toBeNull();
    expect(dialogo![0]).toContain("{PEDIDO_COMPUESTO_NO_RESERVA}");
  });
});
