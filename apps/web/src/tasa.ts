/**
 * LA TASA, LIMPIA (dueño, 2026-09-16): en pantalla una tasa se lee «Tasa BCV: 842,2067» y
 * nada más — ni el servicio por el que llegó, ni la marca de tiempo, ni códigos. Solo existe la
 * tasa del BCV (ADR-0064 §1): no hay otra que nombrar. La fuente completa sigue guardada en su
 * fila (regla 3 de CLAUDE.md); aquí solo se decide cómo se LEE.
 */

/**
 * La tasa con separador de miles y coma decimal, EXACTA: solo se quitan los ceros finales
 * («842.20670000» → «842,2067»). No se redondea: es el número con el que se convirtió, y quien
 * lo compruebe a mano tiene que poder reproducir la cuenta.
 */
export function mostrarTasa(rate: string): string {
  const neg = rate.startsWith("-");
  const [entera = "0", decimal = ""] = (neg ? rate.slice(1) : rate).split(".");
  const ent = entera.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const dec = decimal.replace(/0+$/, "");
  return `${neg ? "-" : ""}${ent}${dec === "" ? "" : `,${dec}`}`;
}

/**
 * El nombre de la tasa. Sin fuente, es la tasa de HOY, que solo puede ser la del BCV. Con fuente,
 * es la congelada en un documento: uno emitido antes de la migración 66 con una tasa tecleada no
 * se rotula «BCV» (revisión fiscal 2026-09-16) — se lee «Tipo de cambio».
 */
export function nombreDeTasa(source?: string): string {
  return source === undefined || /\bbcv\b/i.test(source) ? "Tasa BCV" : "Tipo de cambio";
}

/** «Tasa BCV: 842,2067» — o «Tipo de cambio: 900» para un documento viejo con tasa tecleada. */
export function tasaLimpia(rate: string, source?: string): string {
  return `${nombreDeTasa(source)}: ${mostrarTasa(rate)}`;
}
