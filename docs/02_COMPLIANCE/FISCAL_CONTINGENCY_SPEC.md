# Contingencia fiscal

## Objetivo
Continuar operación conforme a PA102 sin crear una “segunda contabilidad”.

## Escenarios
1. caída de internet;
2. falla móvil;
3. falla eléctrica;
4. imprenta digital no disponible;
5. API Ladino degradada.

## Principios
- modo contingencia explícito;
- identificador único;
- captura de inicio/fin;
- operador;
- causa;
- soporte;
- reconciliación posterior obligatoria;
- no mezclar documentos temporales con emitidos definitivos.

## Offline
El modo offline de Expo será **contingencia controlada**, no modo normal, salvo validación SENIAT.

## Reconciliación
Toda operación offline debe:
- sincronizar;
- detectar duplicados;
- conservar timestamp local y server;
- recibir numeración/control según proceso autorizado;
- adjuntar soporte físico si aplica.

`VALIDAR-SENIAT`: exactitud del flujo con imprenta seleccionada.
