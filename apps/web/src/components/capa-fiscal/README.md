# Capa fiscal

Lo que SOLO ve una empresa que **factura**: IVA, IGTF, alícuotas, vencimientos
fiscales. Las pantallas de la persona (`pages/negocio/**`) y el registro no nombran
nada de esto — lo prueba el gate `test/glosario-capa-fiscal.test.ts` — y pintan estos
componentes solo cuando el modo de venta de la empresa es «facturas»
(`app/modo-venta.ts`, migración 54). Plan «Ladino sin RIF», A4 y A15.
