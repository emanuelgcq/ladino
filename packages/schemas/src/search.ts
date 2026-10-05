import { z } from "zod";

/**
 * LA BÚSQUEDA DE DOCUMENTOS POR NÚMERO (recorrido 2026-09-24, P-06; ADR-0081).
 *
 * La paleta (Ctrl+K) pregunta al SERVIDOR: `GET /v1/search/documents?q=`. La respuesta trae solo
 * lo que el rol puede leer en la empresa de la pestaña: una venta exige `ar.read` o un permiso de
 * operación de ventas; una compra, `ap.read` o registrar o pagar facturas de proveedor. Lo que el
 * rol no puede leer NO APARECE NI SE CUENTA: por eso la respuesta no lleva un total.
 *
 * Ningún importe viaja aquí: es un índice para llegar al documento, no un listado.
 */

/** Los tipos que se buscan por número. Una compra es la factura del proveedor. */
export const SearchDocumentType = z.enum([
  "invoice",
  "receipt",
  "credit_note",
  "debit_note",
  "quote",
  "withdrawal_invoice",
  "withdrawal_credit_note",
  "purchase",
]);
export type SearchDocumentType = z.infer<typeof SearchDocumentType>;

/** Dos caracteres como mínimo —igual que la búsqueda de clientes y productos de la paleta—. */
export const SearchDocumentsQuery = z
  .object({
    q: z.string().trim().min(2).max(40),
  })
  .strict();
export type SearchDocumentsQuery = z.infer<typeof SearchDocumentsQuery>;

export const SearchDocumentItem = z
  .object({
    type: SearchDocumentType,
    id: z.string().uuid(),
    /** Como lo lee la persona: «A-12» en una venta; en una compra, el número del proveedor. */
    number: z.string(),
    /** El cliente o el proveedor, si el documento lo lleva. */
    party_name: z.string().nullable(),
    /** Día del documento (`YYYY-MM-DD`): el de emisión en Caracas, o el de la factura de compra. */
    date: z.string(),
    status: z.string(),
  })
  .strict();
export type SearchDocumentItem = z.infer<typeof SearchDocumentItem>;

export const SearchDocumentsResponse = z
  .object({
    /** Coincidencia exacta primero; después, lo más reciente. Como mucho 6 ventas y 6 compras. */
    items: z.array(SearchDocumentItem),
  })
  .strict();
export type SearchDocumentsResponse = z.infer<typeof SearchDocumentsResponse>;
