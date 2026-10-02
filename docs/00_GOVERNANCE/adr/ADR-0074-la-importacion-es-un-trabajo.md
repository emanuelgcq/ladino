# ADR-0074 — La importación es un trabajo, no una petición

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (§2.9 y §2.12; C-01, C-04,
  C-05)
- **Fecha:** 2026-09-28
- **Impacto fiscal:** NO.

## Contexto

- **C-01:** la importación lee «0.500» como 500 y «0.125» como 125, y termina en verde. Los
  invariantes no lo ven: el kardex inflado y su asiento suben juntos.
- **C-04:** una importación grande agota el tiempo de la petición, dice «No se pudo leer el archivo»
  y sigue creando. Al reintentar, duplica.
- **C-05:** datos que se descartan en silencio, como la existencia de un servicio.

## Decisión

1. **Formato numérico declarado.** El importador pide el formato de los números: coma o punto
   decimal. Por omisión, el de Venezuela (coma decimal, punto de miles), o lo detecta y lo enseña.
2. **Vista previa interpretada.** Antes de confirmar muestra las diez primeras filas **como las va a
   guardar**.
   - Una fila cuyo valor sea ambiguo bajo el formato elegido se **rechaza**, con su número de fila y
     el motivo.
   - Nada se descarta en silencio. La existencia de un servicio se ignora con aviso en la vista
     previa, y el costo sin existencia se acepta como costo de referencia.
3. **Trabajo en segundo plano.** La importación confirmada es un trabajo:
   - con progreso visible;
   - idempotente por el **hash del archivo** y el **código del producto**: al reintentar, ni
     duplica ni crea a medias;
   - con un informe al terminar (creados, actualizados, rechazados con motivo).

## Quién procesa el trabajo

Decidido por criterio (§2.16 de la respuesta del dueño), tras la revisión de la familia (H8):
**el worker procesa el trabajo adoptando `ladino_api`**.

- **La razón.** Crear un producto toca una docena de tablas de negocio: productos, precios, kardex,
  asientos, auditoría y outbox. ADR-0031 dejaba al worker sin privilegio sobre ninguna. Repartirle
  GRANT tabla por tabla, con policies propias, duplicaría la superficie de la API y se quedaría
  desfasado con cada módulo nuevo. Con `grant ladino_api to ladino_worker with inherit false, set
  true` (migración 20260928140000), el worker hace `set local role ladino_api` dentro de la
  transacción de CADA fila, con el actor del trabajo en el GUC. La RLS y la autorización son
  exactamente las de la API para esa persona.
- **El aislamiento, verificado por el revisor:**
  - la empresa del trabajo está anclada por FK y por el trigger de ancla;
  - el tenant se comprueba con `companyScope` en cada fila;
  - el actor sale de `created_by`, que fija el trigger de procedencia y no el cliente;
  - el GUC es local a la transacción;
  - la autorización se repite en cada fila: quien pierde el permiso a mitad de trabajo ve sus filas
    rechazadas.
- **Aplicable en producción.** El coordinador verificó en solo lectura que `postgres` tiene ADMIN
  OPTION sobre `ladino_api` (PG 17.6).
- **El riesgo:** RISK_REGISTER R-56. Quien controle el proceso del worker puede hacer lo que la API
  puede, igual que quien controle la API.
- **Alternativa descartada:** procesar el trabajo en el proceso de la API, en segundo plano tras
  responder, y revocar el GRANT. Se descartó porque ata un trabajo de minutos al ciclo de vida de
  un proceso que se reinicia en cada despliegue, y porque el worker ya tiene el bucle, el latido y
  la contabilidad de fallos.

## Consecuencias

- **Positivas.** Ningún número se interpreta por su cuenta, ninguna importación grande muere a
  medias y reintentar es seguro.
- **Negativas.** Hay una tabla de trabajos, un endpoint de estado y el worker lo procesa.
- **Para revertir:** un archivo pequeño puede seguir procesándose en la petición. La idempotencia
  por hash se queda.

## Verificación

- E2E: «0,500» con formato venezolano da 0,5; «0.500» con formato venezolano se rechaza como
  ambiguo; el reintento del mismo archivo no duplica.
- `pnpm recorrido C`: C-01, C-04 y C-05 dejan de reproducir.
