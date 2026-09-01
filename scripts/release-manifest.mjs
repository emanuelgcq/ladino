#!/usr/bin/env node
// =============================================================================
// Ladino — registro de versiones (ADR-0027 §5, entregable 2)
//
// Un registro de versiones solo sirve si empieza en la PRIMERA release:
// reconstruirlo a posteriori es inferencia sobre el propio historial, que es
// lo que un evaluador no acepta. Este script mantiene `releases/manifest.json`.
//
//   check  — paso de `pnpm verify`. Falla si el manifest no es válido, si
//            alguna migración listada en la última release CAMBIÓ de contenido
//            (una migración aplicada no se edita, ADR-0019), o si hay
//            migraciones en disco que ninguna release cubre y el árbol está
//            etiquetado (= se intenta publicar sin registrar).
//   new <version> [--fiscal-changed] [--note "..."]
//          — crea la entrada de una release con el estado actual.
//   digest <version> <servicio> <sha256:...>
//          — anota el digest de una imagen ya construida.
// =============================================================================

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const RUTA = "releases/manifest.json";
const args = process.argv.slice(2);
const cmd = args[0];

function migracionesEnDisco() {
  return readdirSync("supabase/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      file: f,
      version: f.slice(0, 14),
      // Se hashea con finales de línea normalizados: un checkout Windows con
      // `core.autocrlf=true` convierte a CRLF y, sin esto, el mismo archivo
      // daría un hash distinto al de CI y el check fallaría sin que nadie
      // hubiera editado nada. Lo vio la variante rota, no el diseño.
      sha256_16: createHash("sha256")
        .update(readFileSync(`supabase/migrations/${f}`, "utf8").replace(/\r\n/g, "\n"))
        .digest("hex")
        .slice(0, 16),
    }));
}

function leer() {
  return JSON.parse(readFileSync(RUTA, "utf8"));
}

function git(...a) {
  return execFileSync("git", a, { encoding: "utf8", shell: true }).trim();
}

if (cmd === "check") {
  const m = leer();
  const errores = [];
  if (!Array.isArray(m.releases) || m.releases.length === 0) errores.push("sin releases");
  const ultima = m.releases[m.releases.length - 1];
  const obligatorios = [
    "version",
    "date",
    "git_sha",
    "images",
    "migrations",
    "fiscal_protocol_version",
    "fiscal_regimes_supported",
    "homologation_status",
    "fiscal_behavior_changed",
  ];
  for (const k of obligatorios)
    if (!(k in ultima)) errores.push(`release ${ultima.version}: falta ${k}`);

  const disco = new Map(migracionesEnDisco().map((x) => [x.file, x.sha256_16]));
  for (const [file, hash] of Object.entries(ultima.migrations.sha256_16 ?? {})) {
    const actual = disco.get(file);
    if (!actual)
      errores.push(`la migración ${file} está en la release ${ultima.version} y NO en disco`);
    else if (actual !== hash)
      errores.push(
        `la migración ${file} CAMBIÓ de contenido desde la release ${ultima.version} ` +
          `(${hash} → ${actual}). Una migración aplicada no se edita (ADR-0019).`,
      );
  }
  const sinCubrir = [...disco.keys()].filter((f) => !(f in (ultima.migrations.sha256_16 ?? {})));
  if (sinCubrir.length) {
    const etiquetado = (() => {
      try {
        return git("tag", "--points-at", "HEAD") !== "";
      } catch {
        return false;
      }
    })();
    const msg = `${sinCubrir.length} migración(es) sin release: ${sinCubrir.join(", ")}`;
    if (etiquetado)
      errores.push(msg + " — HEAD está etiquetado: registra la release antes de publicar");
    else console.log(`aviso: ${msg} (normal en desarrollo; entran en la próxima release)`);
  }

  if (errores.length) {
    console.error("release:manifest:check FALLA\n  " + errores.join("\n  "));
    process.exit(1);
  }
  console.log(
    `release:manifest:check OK — última release ${ultima.version}, ${Object.keys(ultima.migrations.sha256_16).length} migraciones cubiertas`,
  );
} else if (cmd === "new") {
  const version = args[1];
  if (!version) {
    console.error('uso: release-manifest new <version> [--fiscal-changed] [--note "..."]');
    process.exit(2);
  }
  const m = leer();
  if (m.releases.some((r) => r.version === version)) {
    console.error(`la release ${version} ya existe`);
    process.exit(1);
  }
  const migs = migracionesEnDisco();
  const noteIdx = args.indexOf("--note");
  m.releases.push({
    version,
    date: new Date().toISOString().slice(0, 10),
    git_sha: git("rev-parse", "HEAD"),
    images: { "ladino-api": null, "ladino-worker": null, "ladino-web": null },
    migrations: {
      from: migs[0]?.version ?? null,
      to: migs[migs.length - 1]?.version ?? null,
      count: migs.length,
      sha256_16: Object.fromEntries(migs.map((x) => [x.file, x.sha256_16])),
    },
    fiscal_protocol_version: null,
    fiscal_regimes_supported: [],
    mobile_min_version: null,
    homologation_status: "not_applicable",
    fiscal_behavior_changed: args.includes("--fiscal-changed"),
    notes: noteIdx >= 0 ? args[noteIdx + 1] : "",
  });
  writeFileSync(RUTA, JSON.stringify(m, null, 2) + "\n");
  console.log(
    `release ${version} registrada (${migs.length} migraciones). Anota los digests con \`digest\` tras el build.`,
  );
} else if (cmd === "digest") {
  const [, version, servicio, digest] = args;
  if (!version || !servicio || !/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) {
    console.error(
      "uso: release-manifest digest <version> <ladino-api|ladino-worker|ladino-web> <sha256:...>",
    );
    process.exit(2);
  }
  const m = leer();
  const r = m.releases.find((x) => x.version === version);
  if (!r) {
    console.error(`no existe la release ${version}`);
    process.exit(1);
  }
  r.images[servicio] = digest;
  writeFileSync(RUTA, JSON.stringify(m, null, 2) + "\n");
  console.log(`${servicio}@${version} → ${digest}`);
} else {
  console.error("uso: release-manifest <check|new|digest>");
  process.exit(2);
}
