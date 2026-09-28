---
name: glosario-alcance-de-carpetas
description: El gate de glosario (TERMINOS_PROHIBIDOS y CAPA_FISCAL) solo recorre pages/negocio y pages/registro; pages/configuracion queda fuera a propósito
metadata:
  type: reference
---

`apps/web/test/glosario.test.ts:23` fija `CARPETAS = [pages/negocio, pages/registro]`, y
`test/glosario-capa-fiscal.test.ts` prueba el mismo alcance (más el `permitidoEn` de RIF que
solo cubre `registro/Registro.tsx` y `negocio/Empezar.tsx`). **`pages/configuracion/**` (Mi
empresa, y en general el admin) NO está cubierto**: ahí "RIF", "régimen", etc. son
vocabulario correcto y esperado (es la pantalla del contador/dueño configurando, no la del
mostrador). No marcar como violación de glosario el uso de "RIF" en `MiEmpresa.tsx` o
similares fuera de `pages/negocio` y `pages/registro`.
