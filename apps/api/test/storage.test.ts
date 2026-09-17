import { afterEach, describe, expect, it, vi } from "vitest";
import { cabecerasServicio, subirObjeto, firmarUrls } from "../src/storage.js";
import { DominioError } from "../src/middleware/errors.js";

/**
 * LA CREDENCIAL DE STORAGE (producción, 2026-09-13 → 2026-09-17). El proyecto de Virginia usa
 * una clave nueva `sb_secret_…`, que no es un JWT. El cliente la mandaba en
 * `Authorization: Bearer` y Storage respondía 400 a toda subida: ni una foto de producto ni un
 * logo se guardó en cuatro días. Aquí se prueba la forma en que viaja cada tipo de clave, y que
 * un rechazo de Storage llega a la persona con un motivo y no como «Error interno».
 */
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.firma";
const SECRETA = "sb_secret_PRUEBA";
const cfg = (serviceKey: string) => ({ url: "https://proyecto.example/storage/v1", serviceKey });

afterEach(() => vi.unstubAllGlobals());

describe("la credencial de servicio de Storage", () => {
  it("una clave nueva (sb_secret) viaja SOLO en apikey: nunca como Bearer", () => {
    expect(cabecerasServicio(SECRETA)).toEqual({ apikey: SECRETA });
  });

  it("una clave heredada (JWT) viaja en apikey y en Authorization", () => {
    expect(cabecerasServicio(JWT)).toEqual({ apikey: JWT, Authorization: `Bearer ${JWT}` });
  });

  it("subir y firmar usan esas cabeceras", async () => {
    const llamadas: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: { headers: Record<string, string> }) => {
        llamadas.push({ url, headers: init.headers });
        return Promise.resolve(new Response("[]", { status: 200 }));
      }),
    );
    await subirObjeto(
      cfg(SECRETA),
      "product-images",
      "e/p/v/original.webp",
      new Uint8Array([1]),
      "image/webp",
    );
    await firmarUrls(cfg(SECRETA), "product-images", ["e/p/v/original.webp"]);
    for (const l of llamadas) {
      expect(l.headers["apikey"]).toBe(SECRETA);
      expect(l.headers["Authorization"]).toBeUndefined();
    }
    expect(llamadas).toHaveLength(2);
  });

  it("VARIANTE ROTA: si Storage rechaza, la persona recibe un motivo (502), no un 500 mudo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ statusCode: "403", error: "Invalid Compact JWS" }), {
            status: 400,
          }),
        ),
      ),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fallo = await subirObjeto(
      cfg(SECRETA),
      "product-images",
      "e/p/v/original.webp",
      new Uint8Array([1]),
      "image/webp",
    ).catch((e: unknown) => e);
    expect(fallo).toBeInstanceOf(DominioError);
    expect((fallo as DominioError).domainError.code).toBe("STORAGE_UNAVAILABLE");
    expect((fallo as DominioError).domainError.message).toContain("No se pudo guardar el archivo");
    // El detalle queda en el log, con el estado de Storage, para diagnosticar sin la pantalla.
    expect(String(error.mock.calls[0]?.[0])).toContain("api.storage_upload_failed");
    expect(String(error.mock.calls[0]?.[0])).toContain('"status":400');
    error.mockRestore();
  });
});
