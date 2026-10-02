/**
 * El documento de identidad — UNA sola función para el mismo dato (recorrido 2026-09-24:
 * M-05, O-04, P-02 tenían la misma raíz: dos formateadores distintos, y cada camino guardaba
 * el RIF a su manera).
 *
 * LA REGLA (dueño, 2026-09-28, RESPUESTA_RECORRIDO A-08 y M-05; cierra OPEN_QUESTIONS #9):
 *  - RIF: letra (V, E, J, G, P, C) + 8 dígitos + 1 dígito verificador. Se acepta con o sin
 *    guiones, se GUARDA normalizado (`V123456789`) y se MUESTRA `V-12345678-9`.
 *  - La ESTRUCTURA se valida y bloquea. El DÍGITO VERIFICADOR se calcula con el módulo 11
 *    del portal del SENIAT y solo AVISA: se acepta y la excepción queda registrada.
 *  - Fuente: la PA SNAT/2026/0080 no fija grafía; la del certificado del SENIAT lleva guiones.
 *    Algoritmo documentado en docs/02_COMPLIANCE/EMISION_FACTURAS.md §5 n.º 3.
 *
 * Decidido por criterio (Estado del recorrido): el cliente puede identificarse con RIF o con
 * cédula (V/E + hasta 8 dígitos, sin dígito verificador: PA 00071 art. 13.7). Un V o E de
 * 9 dígitos es RIF, nunca cédula. La empresa y el proveedor llevan siempre RIF.
 *
 * Vive en @ladino/schemas porque lo importan la API (que DECIDE: normaliza y valida) y la web
 * (que solo avisa antes de guardar y viste para mostrar). Puro: sin I/O, sin dependencias.
 */

/** Las seis letras del RIF. «P» es el RIF de una persona con pasaporte, no «no domiciliado». */
export const LETRAS_RIF = ["V", "E", "J", "G", "P", "C"] as const;
export type LetraRif = (typeof LETRAS_RIF)[number];

/** El marcador que el registro le pone a una empresa SIN RIF (packages/domain onboarding.ts). */
export const MARCADOR_SIN_RIF = "PEND-";

/**
 * Valor de la letra en el módulo 11 del SENIAT. «C» no tiene valor confirmado: con C no se
 * avisa del dígito (VALIDAR-SENIAT abierto en PENDIENTES_ASESOR).
 */
const VALOR_LETRA: Readonly<Record<string, number>> = { V: 1, E: 2, J: 3, P: 4, G: 5 };
/** Pesos: el de la letra primero, luego los 8 dígitos. */
const PESOS = [4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

const RIF_NORMALIZADO = /^[VEJGPC]\d{9}$/;
const CEDULA_NORMALIZADA = /^[VE]\d{1,8}$/;
/**
 * El pasaporte del adquirente persona natural (PA 00071 art. 13.7). Decidido por criterio
 * (revisión 2026-09-28; alternativa: un selector de tipo de documento): «P» + alfanumérico de 5
 * a 20. Se evalúa DESPUÉS del RIF: P + 9 dígitos es el RIF P de una persona con pasaporte.
 */
const PASAPORTE_NORMALIZADO = /^P[0-9A-Z]{5,20}$/;

/** ¿Es el marcador de «todavía no tiene RIF»? */
export function esMarcadorSinRif(crudo: string): boolean {
  return crudo.trim().toUpperCase().startsWith(MARCADOR_SIN_RIF);
}

/**
 * La forma que se GUARDA: mayúsculas, sin guiones, puntos ni espacios. Es la MISMA expresión
 * que el único de clientes (`customers_company_tax_id_uidx`: upper + quitar lo que no es
 * alfanumérico), así que buscar y guardar comparan lo mismo. El marcador `PEND-` no se toca.
 */
export function normalizarDocumento(crudo: string): string {
  const t = crudo.trim();
  if (esMarcadorSinRif(t)) return t;
  return t.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/**
 * El dígito verificador que el SENIAT calcula para un RIF normalizado (letra + 8 dígitos,
 * con o sin el noveno). `null` si la letra no tiene valor confirmado (C) o la forma no es.
 */
export function digitoVerificadorRif(normalizado: string): number | null {
  const m = /^([VEJGPC])(\d{8})\d?$/.exec(normalizado);
  if (!m) return null;
  const valor = VALOR_LETRA[m[1]!];
  if (valor === undefined) return null;
  let suma = valor * PESOS[0];
  const digitos = m[2]!;
  for (let i = 0; i < 8; i++) suma += Number(digitos[i]) * PESOS[i + 1]!;
  const dv = 11 - (suma % 11);
  return dv >= 10 ? 0 : dv;
}

/** Qué dice el dígito verificador: cuadra, no cuadra, o no hay regla (letra C). */
export type DigitoRif = "correcto" | "incorrecto" | "sin_regla";

export type LecturaDocumento =
  | { readonly valido: false }
  | {
      readonly valido: true;
      readonly tipo: "rif";
      readonly normalizado: string;
      readonly digito: DigitoRif;
      /** El que calcula el SENIAT; null con la letra C. */
      readonly esperado: number | null;
    }
  | { readonly valido: true; readonly tipo: "cedula"; readonly normalizado: string }
  | { readonly valido: true; readonly tipo: "pasaporte"; readonly normalizado: string };

/** Lee un RIF (empresa, proveedor): estructura obligatoria, dígito solo informativo. */
export function leerRif(crudo: string): LecturaDocumento {
  if (esMarcadorSinRif(crudo)) return { valido: false };
  const normalizado = normalizarDocumento(crudo);
  if (!RIF_NORMALIZADO.test(normalizado)) return { valido: false };
  const esperado = digitoVerificadorRif(normalizado);
  const digito: DigitoRif =
    esperado === null
      ? "sin_regla"
      : Number(normalizado[9]) === esperado
        ? "correcto"
        : "incorrecto";
  return { valido: true, tipo: "rif", normalizado, digito, esperado };
}

/** Lee el documento de un CLIENTE: un RIF, una cédula (V/E + hasta 8 dígitos) o un pasaporte. */
export function leerDocumentoCliente(crudo: string): LecturaDocumento {
  const rif = leerRif(crudo);
  if (rif.valido) return rif;
  if (esMarcadorSinRif(crudo)) return { valido: false };
  const normalizado = normalizarDocumento(crudo);
  if (CEDULA_NORMALIZADA.test(normalizado)) return { valido: true, tipo: "cedula", normalizado };
  if (PASAPORTE_NORMALIZADO.test(normalizado)) {
    return { valido: true, tipo: "pasaporte", normalizado };
  }
  return { valido: false };
}

/**
 * El aviso del dígito verificador, en palabras, o null si no hay nada que avisar. La web lo
 * enseña ANTES de guardar; el servidor acepta igual y deja la excepción en la auditoría.
 */
export function avisoDigitoRif(crudo: string): string | null {
  const r = leerRif(crudo);
  if (!r.valido || r.tipo !== "rif" || r.digito !== "incorrecto") return null;
  const base = `${r.normalizado[0]}-${r.normalizado.slice(1, 9)}`;
  return (
    `El dígito verificador no cuadra: para ${base} el SENIAT calcula ${r.esperado}, ` +
    `y escribiste ${r.normalizado[9]}. Revísalo en el certificado del RIF; si está bien así, ` +
    `se puede guardar.`
  );
}

/**
 * Viste un documento para ENSEÑARLO o imprimirlo. Solo presentación: los separadores no se
 * guardan ni significan nada, y acepta las dos grafías (los snapshots de documentos emitidos
 * conservan la suya — regla 1 — y se ven igual que los normalizados).
 *  - RIF (letra + 9 dígitos) → `V-12345678-9`, `J-40123456-7` (M-05: un V o E de 9 dígitos
 *    NO se agrupa como cédula);
 *  - cédula (V/E + hasta 8 dígitos) → `V-12.345.678`, como siempre;
 *  - lo demás (pasaporte, datos viejos) sigue la tabla anterior sobre el texto tal cual, y lo
 *    que no tiene forma de documento se enseña sin tocar: vestir no es corregir.
 */
export function formatearDocumento(crudo: string): string {
  if (!esMarcadorSinRif(crudo)) {
    const n = normalizarDocumento(crudo);
    if (RIF_NORMALIZADO.test(n)) return `${n[0]}-${n.slice(1, 9)}-${n[9]}`;
    if (CEDULA_NORMALIZADA.test(n)) {
      return `${n[0]}-${n.slice(1).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
    }
  }
  const m = /^([VEJGPC])([0-9A-Z]+)$/.exec(crudo.toUpperCase());
  if (!m) return crudo;
  const prefijo = m[1]!;
  const resto = m[2]!;
  if (prefijo === "V" || prefijo === "E") {
    return `${prefijo}-${resto.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
  }
  if ((prefijo === "J" || prefijo === "G") && resto.length > 1) {
    return `${prefijo}-${resto.slice(0, -1)}-${resto.slice(-1)}`;
  }
  return `${prefijo}-${resto}`;
}
