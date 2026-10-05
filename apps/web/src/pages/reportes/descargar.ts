import { API_URL, supabase } from "../../lib.js";

/**
 * Baja el archivo que hizo el servidor (csv o xlsx) y lo guarda. Devuelve el mensaje de error
 * en voz de persona, o `null` si se descargó.
 */
export async function descargarReporte(
  ruta: string,
  companyId: string,
  nombrePorOmision: string,
): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token ?? "";
    const r = await fetch(`${API_URL}${ruta}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Company-Id": companyId },
    });
    if (r.status === 403) return "Tu rol puede ver este reporte, pero no descargarlo.";
    if (!r.ok) return "No se pudo preparar el archivo. Vuelve a intentar en un momento.";
    const nombre =
      /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ??
      nombrePorOmision;
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return null;
  } catch {
    return "No hay conexión con el servidor. Revisa tu internet y vuelve a intentar.";
  }
}
