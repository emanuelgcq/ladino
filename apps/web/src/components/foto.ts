/**
 * LA FOTO DEL PRODUCTO, ANTES DE SUBIRLA (dueño, 2026-09-17: «no me deja subirla»).
 *
 * Una foto de teléfono pesa de 3 a 8 MB y la API corta en 6 MB; en datos móviles, además,
 * subirla entera tarda. Se reduce aquí a 2000 px de lado como máximo, en JPEG: la API la vuelve a
 * convertir a webp con sus miniaturas, así que no se pierde nada que se fuera a ver. Si el
 * navegador no sabe leerla (HEIC en Android), se manda tal cual y la API dice el motivo.
 *
 * Es presentación de un archivo: ni dinero ni regla de negocio.
 */
const LADO_MAXIMO = 2000;
const PESO_SIN_TOCAR = 1.5 * 1024 * 1024;

/**
 * Cualquier imagen: el teléfono ofrece la cámara Y la galería. `capture` obligaba a la cámara y
 * no dejaba elegir una foto ya tomada.
 */
export const ACEPTA_FOTOS = "image/*";

export async function prepararFoto(archivo: File): Promise<File> {
  if (typeof createImageBitmap !== "function") return archivo;
  let imagen: ImageBitmap;
  try {
    imagen = await createImageBitmap(archivo, { imageOrientation: "from-image" });
  } catch {
    return archivo;
  }
  const escala = Math.min(1, LADO_MAXIMO / Math.max(imagen.width, imagen.height));
  // Una foto chica, liviana y en un formato que la API acepta no se toca.
  if (
    escala === 1 &&
    archivo.size <= PESO_SIN_TOCAR &&
    /^image\/(jpeg|png|webp)$/.test(archivo.type)
  ) {
    imagen.close();
    return archivo;
  }
  const lienzo = document.createElement("canvas");
  lienzo.width = Math.max(1, Math.round(imagen.width * escala));
  lienzo.height = Math.max(1, Math.round(imagen.height * escala));
  const pincel = lienzo.getContext("2d");
  if (pincel === null) {
    imagen.close();
    return archivo;
  }
  // Fondo blanco: una PNG con transparencia no sale con fondo negro al pasar a JPEG.
  pincel.fillStyle = "#ffffff";
  pincel.fillRect(0, 0, lienzo.width, lienzo.height);
  pincel.drawImage(imagen, 0, 0, lienzo.width, lienzo.height);
  imagen.close();
  const blob = await new Promise<Blob | null>((listo) => lienzo.toBlob(listo, "image/jpeg", 0.85));
  if (blob === null) return archivo;
  return new File([blob], `${archivo.name.replace(/\.[^.]*$/, "") || "foto"}.jpg`, {
    type: "image/jpeg",
  });
}

type Llamar = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Sube la foto ya preparada. Devuelve la URL firmada para enseñarla sin recargar. */
export async function subirFotoProducto(
  llamar: Llamar,
  productoId: string,
  archivo: File,
): Promise<{ image_url: string | null }> {
  const form = new FormData();
  form.append("file", await prepararFoto(archivo));
  return llamar<{ image_url: string | null }>(`/v1/products/${productoId}/image`, {
    method: "POST",
    body: form,
  });
}
