#!/usr/bin/env node
/**
 * Preflight de los pasos 8 y 9 de `pnpm verify`.
 *
 * Sin Docker, el CLI de Supabase falla así:
 *
 *   {"_tag":"Error","error":{"code":"LegacyLocalDbRunningError","message":"failed to inspect service"}}
 *
 * Que no le dice nada a nadie. Quien lo vea por primera vez va a pensar que la migración está
 * rota, no que le falta un demonio. Un gate que falla de forma ilegible se acaba ignorando igual
 * que uno que no falla — el mismo patrón de ADR-0023, por el otro extremo.
 */
import { execFileSync } from "node:child_process";
import process from "node:process";

const rojo = (s) => `[31m${s}[0m`;
const negrita = (s) => `[1m${s}[0m`;

function corre(cmd, args) {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const version = corre("docker", ["--version"]);
if (version === null) {
  console.error(`
${rojo("✗")} ${negrita("Docker no está instalado o no está en el PATH.")}

Los pasos 8 y 9 de \`pnpm verify\` (db:reset y test:rls) levantan Postgres en contenedores.
Desde S0.3 el proyecto tiene base de datos, así que el gate no se puede pasar sin ella.

  1. Instala Docker Desktop y arráncalo.
  2. \`pnpm db:start\`  — levanta el stack local (la primera vez descarga imágenes).
  3. \`pnpm verify\`

Para correr solo lo que no necesita base de datos mientras tanto:
  pnpm run format:check && pnpm run boundaries && pnpm exec turbo run lint typecheck test build
`);
  process.exit(1);
}

const info = corre("docker", ["info", "--format", "{{.ServerVersion}}"]);
if (info === null) {
  console.error(`
${rojo("✗")} ${negrita("Docker está instalado pero el demonio no responde.")}

  ${version}

Arranca Docker Desktop y espera a que el icono deje de girar. Después:
  pnpm db:start && pnpm verify
`);
  process.exit(1);
}

console.log(`✓ Docker ${info} disponible.`);
