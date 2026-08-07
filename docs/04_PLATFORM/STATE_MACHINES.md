# State machines globales

## Documento fiscal
draft → validated → issuing → issued/failed → adjusted.

## Journal
draft → validated → posted → reversed.

## Pago
draft → pending_approval → approved → processing → settled/failed/reversed.

## Orden compra
draft → approved → sent → partially_received → received → closed.

## Inventario conteo
draft → counting → review → posted.

No se permiten saltos de estado desde frontend; cada transición es comando de dominio.
