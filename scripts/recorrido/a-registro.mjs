/**
 * BLOQUE A · REGISTRO Y EMPRESA — por la INTERFAZ, como una persona.
 *
 * Crea las cuentas y registra E1, E2 y E3 con el registro premium, paso a paso, guardando la
 * evidencia de cada pantalla y cronometrando cada paso. Después comprueba en la base lo que quedó.
 *
 * Personas (todas de prueba, en la base LOCAL):
 *   dueña de E1 · dueño de E2 (y luego de E3, por invitación) · quien registra E3.
 * El dueño de E2 no puede crear E3 desde dentro de Ladino: el registro premium solo aparece a
 * quien no tiene ninguna empresa (hallazgo A-01). Por eso E3 la registra otra cuenta y luego lo
 * invita como dueño (bloque N/O).
 */
import fs from "node:fs";
import path from "node:path";
import {
  abrir,
  BASE,
  esperar,
  guardarEstado,
  nuevaEvidencia,
  sql,
  anotar,
  cronometrar,
  textoMain,
} from "./lib.mjs";

export const CLAVE = "Recorrido2026!";
export const PERSONAS = {
  duenaE1: "bodega.esquina@example.com",
  duenoE2E3: "dueno.andina@example.com",
  registraE3: "tornillo@example.com",
  cajero: "cajero@example.com",
  encargado: "encargado@example.com",
  administrativo: "administrativo@example.com",
  contador: "contador@example.com",
  almacenista: "almacenista@example.com",
};

const EMPRESAS = [
  {
    clave: "E1",
    correo: PERSONAS.duenaE1,
    nombre: "Bodega La Esquina",
    rubro: "Bodega y abastos",
    rif: null,
    direccion: "Calle 5 con carrera 3, sector La Esquina, Barquisimeto, Lara",
    logo: "apps/web/public/favicon-512.png",
    telefono: "0414-5550101",
    estado: "Lara",
    ciudad: "Barquisimeto",
    dueno: "María Esquina",
    cedula: "V-12345678",
  },
  {
    clave: "E2",
    correo: PERSONAS.duenoE2E3,
    nombre: "Distribuidora Andina",
    rubro: "Distribuidora",
    rif: { prefijo: "J", numero: "405551234", razon: "Distribuidora Andina, C.A." },
    direccion: "Zona Industrial II, galpón 14, Barquisimeto, Lara",
    logo: null,
    telefono: "0251-5550202",
    estado: "Lara",
    ciudad: "Barquisimeto",
    dueno: "Andrés Andina",
    cedula: "V-9876543",
  },
  {
    clave: "E3",
    correo: PERSONAS.registraE3,
    nombre: "Ferretería El Tornillo",
    rubro: "Ferretería",
    rif: { prefijo: "J", numero: "405559876", razon: "Ferretería El Tornillo, C.A." },
    direccion: "Av. Lara, local 22, Cabudare, Lara",
    logo: null,
    telefono: "0251-5550303",
    estado: "Lara",
    ciudad: "Cabudare",
    dueno: "Tomás Tornillo",
    cedula: "V-11223344",
  },
];

const RAIZ = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
  "..",
  "..",
);

/** «Crea tu cuenta» en la pantalla de entrada. Local: sin verificación de correo, entra directo. */
export async function crearCuenta(page, ev, correo) {
  await page.goto(BASE);
  await esperar(page, 2500);
  await page.getByRole("button", { name: /Crea tu cuenta/ }).click();
  await esperar(page, 800);
  await page.locator('input[type="email"]').first().fill(correo);
  const claves = page.locator('input[type="password"]');
  await claves.nth(0).fill(CLAVE);
  if ((await claves.count()) > 1) await claves.nth(1).fill(CLAVE);
  await ev(page, `cuenta-${correo.split("@")[0]}-lleno`);
  await page.locator('button[type="submit"]').first().click();
  await esperar(page, 4000);
}

async function continuar(page) {
  const b = page.getByRole("button", { name: /^Continuar$/ });
  if ((await b.count()) > 0 && (await b.first().isEnabled())) {
    await b.first().click();
    await esperar(page, 900);
  }
}

async function registrar(page, ev, e) {
  const tiempos = {};
  const paso = async (nombre, fn) => {
    const { ms } = await cronometrar(fn);
    tiempos[nombre] = ms;
    await ev(page, `${e.clave}-${nombre}`, { ms });
  };

  await paso("bienvenida", async () => {
    await page.getByRole("button", { name: /^Empezar$/ }).click();
    await esperar(page, 900);
  });
  await paso("nombre", async () => {
    await page.getByPlaceholder("Abastos La Bendición").fill(e.nombre);
    await continuar(page);
  });
  await paso("rubro", async () => {
    await page.getByRole("radio", { name: new RegExp(e.rubro) }).click();
    await esperar(page, 600);
    await continuar(page);
  });
  await paso("rif", async () => {
    await page.getByRole("radio", { name: e.rif ? /Sí, tengo RIF/ : /Todavía no/ }).click();
    await esperar(page, 900);
    await continuar(page);
  });
  if (e.rif) {
    await paso("rif-numero", async () => {
      await page
        .getByLabel("Tipo de RIF")
        .selectOption(e.rif.prefijo)
        .catch(() => {});
      await page.getByPlaceholder("401234567").fill(e.rif.numero);
      await continuar(page);
    });
    await paso("razon", async () => {
      await page.getByPlaceholder("Inversiones La Bendición, C.A.").fill(e.rif.razon);
      await continuar(page);
    });
  }
  // Algunas ramas saltan pasos: se contesta lo que la pantalla pregunte, en el orden que salga.
  for (let vuelta = 0; vuelta < 8; vuelta += 1) {
    const t = await textoMain(page);
    if (/Crear mi negocio/.test(t)) break;
    if ((await page.getByPlaceholder("Av. Bolívar, local 7, Valencia, Carabobo").count()) > 0) {
      await paso("direccion", async () => {
        await page.getByPlaceholder("Av. Bolívar, local 7, Valencia, Carabobo").fill(e.direccion);
        await continuar(page);
      });
      continue;
    }
    if (/Ponle la cara a tu negocio/.test(t)) {
      await paso("logo", async () => {
        if (e.logo) {
          await page.locator('input[type="file"]').setInputFiles(path.join(RAIZ, e.logo));
          await esperar(page, 2500);
          await page.getByRole("button", { name: /^Continuar$/ }).click();
        } else {
          await page.getByRole("button", { name: /^Después$/ }).click();
        }
        await esperar(page, 900);
      });
      continue;
    }
    if ((await page.getByPlaceholder("0414-1234567").count()) > 0) {
      await paso("contacto", async () => {
        await page.getByPlaceholder("0414-1234567").fill(e.telefono);
        await page
          .getByLabel("Estado")
          .selectOption({ label: e.estado })
          .catch(() => {});
        await esperar(page, 500);
        const ciudadSel = page.locator('select[aria-label="Ciudad"]');
        if ((await ciudadSel.count()) > 0) {
          await ciudadSel.selectOption({ label: e.ciudad }).catch(async () => {
            await ciudadSel.selectOption({ index: 1 });
          });
        } else {
          await page
            .getByPlaceholder("Escribe tu ciudad")
            .fill(e.ciudad)
            .catch(() => {});
        }
        await continuar(page);
      });
      continue;
    }
    if ((await page.getByPlaceholder("Tu nombre completo").count()) > 0) {
      await paso("tu", async () => {
        await page.getByPlaceholder("Tu nombre completo").fill(e.dueno);
        await page
          .getByPlaceholder("V-12345678 (opcional)")
          .fill(e.cedula)
          .catch(() => {});
        await continuar(page);
      });
      continue;
    }
    // Pantalla desconocida: se documenta y se intenta seguir.
    await ev(page, `${e.clave}-pantalla-inesperada-${vuelta}`);
    await continuar(page);
  }
  await paso("resumen", async () => {
    await page.getByRole("button", { name: /Crear mi negocio/ }).click();
    await esperar(page, 6000);
  });
  await ev(page, `${e.clave}-aterrizaje`);
  return tiempos;
}

// ── Guion ─────────────────────────────────────────────────────────────────────
const resultados = {};
for (const e of EMPRESAS) {
  const { browser, page, eventos } = await abrir();
  const ev = nuevaEvidencia("A", eventos);
  await crearCuenta(page, ev, e.correo);
  await ev(page, `${e.clave}-tras-crear-cuenta`);
  const tiempos = await registrar(page, ev, e);

  const fila = sql(`
    select c.id, coalesce(c.tax_id,'(sin rif)'), c.legal_name, coalesce(c.trade_name,''),
           coalesce(c.logo_path,'(sin logo)'), (select count(*) from public.warehouses w where w.company_id = c.id)
      from public.companies c
      join public.memberships m on m.tenant_id = c.tenant_id
      join auth.users u on u.id = m.user_id
     where u.email = '${e.correo}'
     order by c.created_at desc limit 1`)[0];
  resultados[e.clave] = { correo: e.correo, fila, tiempos, url: page.url() };
  if (!fila) {
    anotar("A", {
      id: `A-${e.clave}-sin-empresa`,
      severidad: "crítica",
      detalle: "El registro no dejó empresa en la base",
      empresa: e.clave,
    });
  }
  await browser.close();
}

guardarEstado({
  personas: PERSONAS,
  clave: CLAVE,
  empresas: Object.fromEntries(
    Object.entries(resultados).map(([k, v]) => [k, { id: v.fila?.[0] ?? null, correo: v.correo }]),
  ),
});
fs.writeFileSync(
  path.join(
    RAIZ,
    ".recorrido",
    process.env.RECORRIDO_FECHA ?? new Date().toISOString().slice(0, 10),
    "A",
    "resultado.json",
  ),
  JSON.stringify(resultados, null, 2),
);
for (const [k, v] of Object.entries(resultados)) {
  console.log(k, "→", v.fila ? v.fila.join(" | ") : "SIN EMPRESA", "· aterrizó en", v.url);
  console.log("   tiempos (ms):", JSON.stringify(v.tiempos));
}
