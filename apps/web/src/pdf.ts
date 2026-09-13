import { API_URL, supabase } from "./lib.js";

/**
 * Abrir un PDF de la API en una pestaña nueva.
 *
 * El PDF exige el Bearer, así que se baja con `fetch` y se abre como blob.
 * La pestaña se abre ANTES del primer `await`: un `window.open` después de
 * dos esperas de red llega fuera del gesto del usuario y los bloqueadores de
 * ventanas emergentes lo cancelan sin decir nada (auditoría 2026-09-11: la
 * API respondía 200 y no se abría nada). El objeto URL se revoca cuando la
 * pestaña ya lo cargó.
 */
export async function abrirPdf(
  ruta: string,
  companyId: string,
  onError: (mensaje: string) => void,
): Promise<void> {
  const pestana = window.open("about:blank", "_blank");
  if (pestana === null) {
    onError(
      "El navegador bloqueó la pestaña del PDF. Permite las ventanas emergentes para Ladino.",
    );
    return;
  }
  pestana.document.title = "Preparando el PDF…";
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token ?? "";
    const r = await fetch(`${API_URL}${ruta}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Company-Id": companyId },
    });
    if (!r.ok) {
      pestana.close();
      onError("Vuelve a intentar en un momento.");
      return;
    }
    const url = URL.createObjectURL(await r.blob());
    pestana.location.replace(url);
    // La pestaña ya tiene el documento en memoria; el enlace temporal sobra.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    pestana.close();
    onError("No hay conexión con el servidor. Revisa tu internet y vuelve a intentar.");
  }
}
