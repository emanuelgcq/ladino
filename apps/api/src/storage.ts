import type { StorageConfig } from "./config.js";
import { DominioError } from "./middleware/errors.js";

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

/**
 * Las cabeceras de la credencial de servicio.
 *
 * Las claves NUEVAS de Supabase (`sb_secret_…`) no son JWT: van en `apikey` y el gateway pone el
 * rol por su cuenta. Mandarlas en `Authorization: Bearer` las hace fallar como JWT inválido, y
 * Storage respondía 400 a TODA subida: del 2026-09-13 (mudanza al proyecto de Virginia, que usa
 * `sb_secret`) al 2026-09-17 no se guardó ni una foto ni un logo en producción. Una clave
 * heredada (la `service_role` JWT, la del stack local) sigue yendo también en `Authorization`.
 */
export function cabecerasServicio(clave: string): Record<string, string> {
  return /^eyJ/.test(clave)
    ? { apikey: clave, Authorization: `Bearer ${clave}` }
    : { apikey: clave };
}

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
      ...cabecerasServicio(cfg.serviceKey),
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    // Se copia a un ArrayBuffer plano: el tipo DOM `BodyInit` no existe en la
    // lib de Node y un Uint8Array sobre un buffer compartido no es asignable.
    body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
  });
  if (!r.ok) {
    // El detalle va al LOG (nunca a la pantalla: puede nombrar la credencial o el bucket); la
    // persona recibe un motivo que se entiende. Antes era un 500 «Error interno» sin rastro.
    const detalle = await r.text().catch(() => "");
    console.error(
      JSON.stringify({
        nivel: "error",
        evento: "api.storage_upload_failed",
        bucket,
        status: r.status,
        detalle: detalle.slice(0, 300),
      }),
    );
    throw new DominioError({
      code: "STORAGE_UNAVAILABLE",
      message:
        "No se pudo guardar el archivo en el almacenamiento. Intenta de nuevo en un rato; si sigue fallando, avisa a soporte.",
    });
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
      ...cabecerasServicio(cfg.serviceKey),
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

/**
 * Descarga un objeto con la credencial de servicio (para incrustarlo en un
 * PDF, no para servirlo). `null` si no existe o el storage no responde: el
 * llamante decide el fallback — nunca un error de usuario por un adorno.
 */
export async function descargarObjeto(
  cfg: StorageConfig,
  bucket: string,
  path: string,
): Promise<Buffer | null> {
  try {
    const r = await fetch(`${cfg.url}/object/${bucket}/${path}`, {
      headers: cabecerasServicio(cfg.serviceKey),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}
