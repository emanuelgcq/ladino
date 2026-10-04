import { describe, expect, it } from "vitest";
import { CreateInvoiceRequest, QuickSaleRequest } from "./sales.js";

/**
 * P-05 · la FORMA de `due_date`: un día `AAAA-MM-DD`. Existe porque la expresión regular estuvo
 * un rato sin sus barras (`/^d{4}-d{2}-d{2}$/`) y rechazaba TODA fecha válida: lo cazó el E2E, y
 * este test lo caza sin base de datos. Que el día exista en el calendario y no sea anterior al de
 * la venta lo decide el dominio (`e2e-el-fiado-vence.test.ts`).
 */
const ID = "01a1064d-c573-7e16-b92d-4344058db64a";
const caja = (due?: unknown) => ({
  company_id: ID,
  warehouse_id: ID,
  customer_id: ID,
  lines: [{ product_id: ID, quantity: "1" }],
  ...(due === undefined ? {} : { due_date: due }),
});

describe("due_date: un día AAAA-MM-DD", () => {
  it("la caja y la factura aceptan un día bien escrito, y su ausencia", () => {
    expect(QuickSaleRequest.safeParse(caja("2026-10-19")).success).toBe(true);
    expect(QuickSaleRequest.safeParse(caja()).success).toBe(true);
    expect(CreateInvoiceRequest.safeParse(caja("2026-10-19")).success).toBe(true);
    expect(CreateInvoiceRequest.safeParse(caja()).success).toBe(true);
  });

  it.each(["19/10/2026", "2026-10-19T00:00:00Z", "2026-1-9", "dddd-dd-dd", "", 20261019, null])(
    "rechaza %s",
    (malo) => {
      const r = QuickSaleRequest.safeParse(caja(malo));
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.path).toEqual(["due_date"]);
      expect(CreateInvoiceRequest.safeParse(caja(malo)).success).toBe(false);
    },
  );
});
