#!/usr/bin/env bash
# Contexto mínimo al arrancar cualquier sesión de Claude Code en Ladino.
set -uo pipefail
echo "=== LADINO — contexto de sesión ==="
echo "Rama: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'sin git')"
echo "Migraciones aplicadas: $(ls -1 supabase/migrations/*.sql 2>/dev/null | wc -l)"
echo ""
echo "RECORDATORIO:"
echo " - Investigar y planificar antes de implementar. Esperar aprobación explícita."
echo " - Nada de float para dinero. Nada de service_role en cliente."
echo " - No editar migraciones aplicadas ni tablas append-only."
echo " - No tocar el contenedor n8n del VPS."
echo " - Reportar HOMOLOGATION_IMPACT en cada entrega."
echo "==================================="
exit 0
