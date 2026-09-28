/**
 * Bloque B · Primer día. Comprobaciones de `pnpm recorrido B` (ver `_app.mjs`).
 *
 * B-16 (ADR-0068 §1): el encargado tiene `product.manage` y no `price_list.manage`, y el alta
 * simple con precio le daba 403. El precio del alta lo autoriza el alta. Ya no debe reproducir.
 */
import { comprobaciones, pedir, afirmar, sql, EMPRESAS, PERSONAS } from "./_app.mjs";

const c = comprobaciones("B");

c.caso(
  "B-16",
  "encargado@ da de alta en E2 un producto con precio → 201 y el precio puesto",
  async () => {
    const nombre = `Verificación B-16 ${Date.now().toString(36)}`;
    const r = await pedir(PERSONAS.encargado, "E2", "POST", "/v1/products/simple", {
      company_id: EMPRESAS.E2,
      name: nombre,
      price: { amount: "3", currency: "USD" },
    });
    afirmar(r.status === 201, `esperaba 201, llegó ${r.status}: ${r.texto.slice(0, 200)}`);
    // Lo que solo produce el arreglo: el precio quedó en una lista, no solo el producto.
    const [precio] = await sql`
    select amount::text as amount from public.price_list_items
     where company_id = ${EMPRESAS.E2} and product_id = ${r.json.product.id}`;
    afirmar(precio?.amount === "3.00000000", `el precio quedó en ${precio?.amount}`);
  },
);

export default c.correr;
