/*
 * El service worker de Ladino (2026-09-14). Existe para dos cosas y nada más:
 *
 *   1. que el teléfono ofrezca INSTALAR la app (Chrome lo exige);
 *   2. que abrirla sea rápido: el código (/assets, con hash en el nombre, que
 *      nunca cambia de contenido) se sirve de la caché del teléfono.
 *
 * Lo que NO hace, a propósito:
 *   · nunca guarda respuestas de la API ni de Supabase — son de otro origen y
 *     este worker solo atiende peticiones del propio sitio. Un precio, un stock
 *     o un saldo servido de caché sería un dato falso en una caja;
 *   · no vende sin conexión. Una venta es un caso de uso transaccional del
 *     servidor; la app sin red avisa, no simula.
 *
 * La página (index.html) va SIEMPRE primero a la red: tras un deploy, la app
 * abre la versión nueva. La copia guardada solo se usa si no hay red.
 */
const VERSION = "ladino-2026-09-14";
const CACHE_CODIGO = `${VERSION}-assets`;
const CACHE_PAGINA = `${VERSION}-pagina`;

// Cada deploy trae archivos con hash nuevo; los viejos no se vuelven a pedir.
// Se conservan los más recientes y el resto se borra, para que la caché no
// crezca deploy tras deploy en el teléfono.
const MAX_CODIGO = 150;
function recortar(cache) {
  return cache.keys().then((claves) => {
    const sobran = claves.length - MAX_CODIGO;
    if (sobran <= 0) return undefined;
    return Promise.all(claves.slice(0, sobran).map((k) => cache.delete(k)));
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_PAGINA)
      .then((c) => c.add(new Request("/", { cache: "reload" })))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((nombres) =>
        Promise.all(nombres.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navegación: red primero; sin red, la última página guardada.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copia = res.clone();
            void caches.open(CACHE_PAGINA).then((c) => c.put("/", copia));
          }
          return res;
        })
        .catch(() =>
          caches.match("/").then((r) => r ?? new Response("Sin conexión", { status: 503 })),
        ),
    );
    return;
  }

  // Código con hash: caché primero (su contenido no cambia jamás).
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(CACHE_CODIGO).then((c) =>
        c.match(req).then(
          (guardada) =>
            guardada ??
            fetch(req).then((res) => {
              if (res.ok) void c.put(req, res.clone()).then(() => recortar(c));
              return res;
            }),
        ),
      ),
    );
  }
  // Todo lo demás (iconos, manifest, sw.js): la red, como sin worker.
});
