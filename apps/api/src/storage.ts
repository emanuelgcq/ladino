import type { StorageConfig } from "./config.js";

/**
 * Cliente MÍNIMO del Storage de Supabase, por REST y con la credencial de
 * servicio. Sin SDK: son dos endpoints y un contrato estable, y cada byte de
 * dependencia en el camino de la credencial de servicio es superficie.
 *
 * La ESCRITURA solo pasa por aquí: la política del bucket (migración 28) no
 * concede INSERT a ningún rol de cliente. La LECTURA del navegador va por
 * URLs FIRMADAS con caducidad — persistir una URL firmada sería persistir un
 * secreto con fecha de muerte, por eso la base guarda rutas y la API firma al
 * servir.
 */
export async function subirObjeto(
  cfg: StorageConfig,
  bucket: string,
  path: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  const r = await fetch(`${cfg.url}/object/${bucket}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.serviceKey}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    // Se copia a un ArrayBuffer plano: el tipo DOM `BodyInit` no existe en la
    // lib de Node y un Uint8Array sobre un buffer compartido no es asignable.
    body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  });
  if (!r.ok) {
    const detalle = await r.text().catch(() => "");
    throw new Error(`storage: subir ${path} → HTTP ${r.status} ${detalle.slice(0, 300)}`);
  }
}

/**
 * Firma en LOTE. Devuelve ruta → URL absoluta; una ruta que el storage no
 * conozca simplemente no aparece en el mapa (la pantalla enseña el placeholder
 * de inicial, que es el diseño, no un error).
 */
export async function firmarUrls(
  cfg: StorageConfig,
  bucket: string,
  paths: readonly string[],
  expiresInSeconds = 3600,
): Promise<Map<string, string>> {
  const firmadas = new Map<string, string>();
  if (paths.length === 0) return firmadas;
  const r = await fetch(`${cfg.url}/object/sign/${bucket}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: expiresInSeconds, paths }),
  });
  if (!r.ok) return firmadas;
  const filas = (await r.json().catch(() => [])) as {
    path?: string | null;
    signedURL?: string | null;
    error?: string | null;
  }[];
  for (const f of filas) {
    if (f.path && f.signedURL && !f.error) {
      firmadas.set(f.path, `${cfg.url}${f.signedURL}`);
    }
  }
  return firmadas;
}
