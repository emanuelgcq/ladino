---
name: producto-selector-empresa
description: Puntos de código verificados sobre el selector de empresa y el switcher (session.tsx, shell.tsx, rif.ts) — para no releerlos desde cero en el próximo recorrido
metadata:
  type: project
---

Verificado en el recorrido 2026-09-24, bloque O (dueño con E2 y E3):

- `apps/web/src/app/session.tsx:55` — la empresa activa se persiste en `localStorage` bajo la clave `ladino.company.<userId>`: UNA sola clave por usuario, compartida por TODAS las pestañas de esa cuenta en el mismo navegador.
- `session.tsx:134-138` (dentro de `recargar`) — al montar/recargar la página se lee esa clave y se fija como empresa activa si sigue en la lista de empresas del usuario.
- `session.tsx:168-176` — el efecto que llama `recargar` se dispara por `userId`, es decir, en cada montaje de `SessionProvider` (recarga de página), no solo al iniciar sesión.
- `session.tsx:178-184` (`setEmpresa`) — escribe en la MISMA clave; no hay `addEventListener("storage", …)` ni `BroadcastChannel` para avisar a otras pestañas (grep sin resultados en todo `apps/web/src`).
- Consecuencia (no ejecutada en el recorrido, ver EP-O-03): si la pestaña A recarga después de que la pestaña B cambió de empresa, A puede aterrizar silenciosamente en la empresa de B. Mientras ninguna de las dos recarga, cada una conserva su estado de React normalmente (confirmado: la pestaña 1 siguió en E2 y cobró correctamente ahí después de que la 2 cambió a E3).
- `apps/web/src/pages/negocio/Vender.tsx:163-164` — `<VenderDeEmpresa key={empresa.id} />`: cambiar de empresa DESDE el switcher, en la MISMA pestaña, remonta la pantalla de venta entera (buen patrón: nada de un carrito de una empresa filtrándose a otra dentro de la misma pestaña).
- `apps/web/src/app/rif.ts:21-23` (`rifParaMostrar`) — devuelve `tax_id` tal cual está en la base, sin guiones. El selector (`session.tsx:801-805`) y el switcher (`shell.tsx:556`) lo usan tal cual → RIF de la EMPRESA sale crudo («J405551234»), mientras que clientes/proveedores de esas mismas empresas sí llevan el guion («J-40999888-1»).
- `apps/web/src/lib.ts:111-112` — el tipo `Company` ya tiene `logo_url: string | null` («URL firmada del logo… o null»); ni `SelectorEmpresa` (session.tsx) ni `CompanySwitcher` (shell.tsx) lo usan — ambos pintan el mismo icono `Building2` para cualquier empresa.
- `apps/web/src/app/shell.tsx:537` vs `:554` — el botón del switcher (trigger) muestra `empresa.trade_name ?? empresa.legal_name`, pero la LISTA desplegable de empresas siempre muestra `c.legal_name` (nunca `trade_name`). Con una empresa cuyo nombre comercial difiera de la razón social, el rótulo del botón y el de su propia fila en la lista no coinciden. No reproducido visualmente en el recorrido (las empresas de prueba no tenían `trade_name` distinto) — queda como sospecha fundada en código.
