---
name: mercado-multiempresa
description: Datos estructurados de competidores sobre cambio de empresa/tenant (aislamiento de sesión, logo en selector, mezcla de datos)
metadata:
  type: project
---

Formato: capacidad · competidor · fuente (URL, fecha consulta) · clasificación · ¿copiable en semanas?

- Bloquear la sesión de otra pestaña/ventana al cambiar de empresa en el mismo navegador · QuickBooks Online · https://quickbooks.intuit.com/learn-support/en-us/account-management/is-there-a-way-to-have-quickbooks-online-desktop-application/00/1414237 (consultado 2026-09-28) · estándar de control de sesión, no específico de Venezuela · copiable en semanas: sí (lógica de sesión, no de dominio fiscal)
- Ninguno de los revisados (Odoo, QuickBooks) muestra el logo de la empresa en el selector/switcher nativamente; Odoo lo resuelve con un módulo de terceros ("Multicompany - Easy Switch Company") · https://apps.odoo.com/apps/modules/9.0/web_easy_switch_company (consultado 2026-09-28) · no aplica como diferencial (ni el líder lo hace nativo) · copiable en semanas: sí si Ladino decide hacerlo — ya tiene `logo_url` en el modelo de empresa (`apps/web/src/lib.ts:111-112`) sin usar en el selector
- Cambiar de empresa nunca mezcla datos de otra (aislamiento de catálogo/libros) · QuickBooks Online, Odoo (checkboxes de empresa activa) · fuentes arriba (2026-09-28) · estándar de la categoría · Ladino ya lo cumple (verificado en recorrido 2026-09-24 bloque O, 004-016) — paridad, no brecha

Nota: investigación acotada (2 búsquedas, 2 competidores) por presupuesto de herramientas del recorrido 2026-09-24 bloque O. Pendiente ampliar a Fina, Gálac, Profit Plus, Saint, Valery, Stellar, ERPNext, Loyverse específicamente para el caso "varias empresas del mismo dueño".
