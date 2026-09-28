---
name: flushsync-toast-benigno
description: El warning de consola "flushSync was called from inside a lifecycle method" es conocido, documentado y benigno — no reportarlo como hallazgo nuevo
metadata:
  type: reference
---

`apps/web/src/ui/toast.tsx:76-80` documenta con nombre y apellido este warning: nace en
`ToastRoot` de Base UI (`@base-ui-components/react` 1.0.0-rc.0), que mide su alto con
`flushSync` dentro de un layout effect al montarse. No nace en el código de Ladino (el propio
comentario aclara que el alta de un toast SÍ se difiere a microtarea a propósito). Ya
corregido upstream (flushSync condicional); pendiente de la actualización de la librería.

Aparece en consola cada vez que un diálogo se cierra y un toast de éxito aparece justo
después (logo, cambios de RIF, etc. — visto 3 veces en el recorrido 2026-09-24 bloque A).
No reportar esto como hallazgo nuevo de un recorrido; si aparece, es ESPERADO hasta que se
actualice la librería.
