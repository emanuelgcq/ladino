# PA102 — facturación por medios digitales

## Ámbito
SNAT/2024/000102 regula uso de medios digitales para:
- facturas;
- notas débito;
- notas crédito;
- órdenes de entrega/guías;
- comprobantes de retención.

## Decisiones relevantes

- Operaciones exclusivamente electrónicas/web están dentro del régimen obligatorio descrito por la providencia.
- Contribuyentes obligados a máquina fiscal que además operen por web deben separar el medio aplicable a esas operaciones.
- El Libro de Ventas debe poder separar operaciones por máquina fiscal y operaciones electrónicas cuando aplique.

## Factura digital
Debe soportar todos los campos exigidos por Art. 7, incluidos:
- denominación;
- numeración consecutiva y única;
- datos fiscales del emisor;
- número de control asignado por imprenta digital;
- rango/control cuando aplique;
- fecha/hora;
- datos del adquiriente;
- detalle/código/precio/cantidad;
- tratamiento IVA;
- demás numerales del artículo.

No cerrar el template final con esta lista resumida: la implementación debe tener un mapeo literal numeral→campo→validación en el expediente.

## Acceso
PA102 contempla acceso permanente del SENIAT a documentos emitidos por un lapso de diez años en el régimen de autorización descrito.

## Imprenta digital
La arquitectura debe enviar estructura del documento al proveedor autorizado para validación/asignación requerida.

## Contingencia
PA102 Art. 16 contempla escenarios de:
- falla internet;
- falla dispositivo móvil;
- falla eléctrica y uso de formatos físicos autorizados;
con registro posterior y resguardo de soportes.

`VALIDAR-SENIAT`: modelar exactamente la secuencia operativa admitida para Ladino y el proveedor de imprenta elegido.
