import type { JWTVerifyGetKey } from "jose";
import { remoteJwks, type AuthConfig } from "./middleware/auth.js";

/**
 * Configuración de arranque, PURA: recibe el entorno como argumento y devuelve
 * la configuración o lanza `ConfigError`. `server.ts` es quien decide que un
 * `ConfigError` es `process.exit(1)`. Separarlo permite probar cada regla de
 * rechazo sin arrancar nada — y la regla más importante de este fichero no
 * estaba probada hasta que el auditor de S0.6a lo señaló (F-2).
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export type Entorno = Readonly<Record<string, string | undefined>>;

function requerida(env: Entorno, nombre: string): string {
  const v = env[nombre];
  if (!v) throw new ConfigError(`falta la variable de entorno ${nombre}`);
  return v;
}

const HOSTS_LOCALES = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);

/**
 * DOS CAPAS INDEPENDIENTES contra `hs256` fuera del stack local, porque una
 * sola señal no es una defensa:
 *
 *   1. `NODE_ENV=production` lo rechaza — la imagen y el compose lo fijan.
 *   2. El EMISOR tiene que ser local. Un `node dist/server.js` suelto en un
 *      VPS, sin `NODE_ENV`, con `hs256` y el issuer del proyecto remoto, no
 *      arranca: el secreto legacy compartido no verifica nada contra un
 *      proyecto que firma ES256, y aceptarlo sería confiar en un `sub` que
 *      cualquiera escribe.
 */
export function configAuth(
  env: Entorno,
  /** Inyectable para los tests: en producción es `remoteJwks`. */
  getKey: (url: string) => JWTVerifyGetKey = remoteJwks,
): AuthConfig {
  const modo = env["LADINO_AUTH_MODE"] ?? "jwks";
  const issuer = requerida(env, "SUPABASE_AUTH_ISSUER");

  if (modo === "jwks") {
    return { mode: "jwks", getKey: getKey(requerida(env, "SUPABASE_JWKS_URL")), issuer };
  }
  if (modo === "hs256") {
    if (env["NODE_ENV"] === "production") {
      throw new ConfigError("LADINO_AUTH_MODE=hs256 no se acepta con NODE_ENV=production");
    }
    let host: string;
    try {
      host = new URL(issuer).hostname;
    } catch {
      throw new ConfigError(`SUPABASE_AUTH_ISSUER no es una URL: ${issuer}`);
    }
    if (!HOSTS_LOCALES.has(host)) {
      throw new ConfigError(
        `LADINO_AUTH_MODE=hs256 solo se acepta contra un emisor local; el emisor es ${host}`,
      );
    }
    return {
      mode: "hs256",
      jwtSecret: new TextEncoder().encode(requerida(env, "SUPABASE_JWT_SECRET")),
      issuer,
    };
  }
  throw new ConfigError(`LADINO_AUTH_MODE inválido: ${modo} (jwks | hs256)`);
}

/**
 * Almacenamiento de objetos (fotos de producto, recibos — Fase C). La clave es
 * la CREDENCIAL DE SERVICIO y vive SOLO aquí, en el servidor: la política del
 * bucket no concede escritura a nadie más (migración 28). Opcional: sin las
 * dos variables, los endpoints de imagen responden que no hay almacenamiento.
 */
export interface StorageConfig {
  /** p. ej. http://127.0.0.1:54321/storage/v1 en local. */
  readonly url: string;
  readonly serviceKey: string;
}

export function configStorage(env: Entorno): StorageConfig | undefined {
  const url = env["SUPABASE_STORAGE_URL"];
  const serviceKey = env["SUPABASE_STORAGE_KEY"];
  if (!url || !serviceKey) return undefined;
  return { url, serviceKey };
}

export interface ServerConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly auth: AuthConfig;
  readonly storage?: StorageConfig | undefined;
  /** Peticiones por minuto y usuario autenticado en /v1/*. */
  readonly rateLimitPorMinuto: number;
  /** Plazo máximo de una petición a /v1/*, en ms. */
  readonly requestTimeoutMs: number;
  /** Origen permitido para CORS (el dominio de la webapp). */
  readonly corsOrigin: string;
}

function entero(env: Entorno, nombre: string, porDefecto: number): number {
  const v = env[nombre];
  if (v === undefined || v === "") return porDefecto;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${nombre} debe ser un entero > 0`);
  return n;
}

export function configServidor(env: Entorno): ServerConfig {
  return {
    databaseUrl: requerida(env, "DATABASE_URL"),
    port: entero(env, "PORT", 3000),
    auth: configAuth(env),
    storage: configStorage(env),
    rateLimitPorMinuto: entero(env, "RATE_LIMIT_PER_MINUTE", 300),
    // 30 s: MUY por debajo de los 15 min del reaper de idempotencia (F-10):
    // ninguna petición puede seguir viva cuando el reaper libera su clave.
    requestTimeoutMs: entero(env, "REQUEST_TIMEOUT_MS", 30_000),
    // 5174 desde 2026-08-27: 5173 lo ocupa otro proyecto en la máquina de
    // desarrollo. El puerto de la webapp y este default van juntos — si uno
    // cambia sin el otro, el navegador falla en el preflight y el error que se
    // ve es «no se pudo conectar», que no dice nada de CORS.
    corsOrigin: env["CORS_ORIGIN"] ?? "http://127.0.0.1:5174",
  };
}
