---
name: mercado-cobranza-fiado
description: Capacidades de cobranza de fiado/CxC en competidores (Fina, Gálac, Loyverse) — dato para comparar contra Ladino
metadata:
  type: project
---

Datos de mercado sobre cobranza de fiado y recordatorio de deuda (frente A, bloque F del
recorrido 2026-09-24). Formato: capacidad · competidor · fuente (URL, fecha) · clasificación ·
¿copiable en semanas?

- Envío de estado de cuenta / reporte por WhatsApp desde el sistema · Gálac (Administrativo
  25.2) · https://galac.com/galac-blog/administrativo-version-25-2/ (visto 2026-09-25) ·
  estándar (Ladino ya lo tiene: enlace `wa.me` con texto prellenado,
  `apps/web/src/pages/clientes/Clientes.tsx:884`) · sí, es solo un deep-link.
- Vista de cuentas por cobrar/por pagar con recordatorios programados · Fina («+5.000 negocios
  en Venezuela») · https://www.finapartner.com/ y nota de G-Talent
  https://www.g-talent.net/blogs/finanzas-administracion/cuentas-por-cobrar-venezuela-2026-whatsapp-excel-ia
  (visto 2026-09-25) · estándar · sí.
- Venta a crédito / cuenta corriente de cliente (fiado) · AUSENTE en Loyverse a la fecha —
  sigue en pedido de la comunidad, workaround manual con un "Account Balance" como forma de
  pago · https://loyverse.town/topic/4801-credit-sales/ (visto 2026-09-25) · diferencial para
  Ladino frente a Loyverse específicamente (no frente a Fina/Gálac, que sí lo tienen) · no en
  semanas (es una pieza estructural que a Loyverse le falta desde hace años, no una omisión
  reciente).

No verificado con la misma profundidad: Profit Plus, Saint, Valery, Stellar, Odoo, ERPNext,
QuickBooks (frente A de este bloque quedó parcial — solo Q7, breve, según el encargo).
