# Impresoras fiscales e imprentas digitales

## Imprenta digital
Componente requerido en el régimen digital de PA102 según sus supuestos.

### Adapter interface
- validate_document(payload)
- allocate_control(payload)
- query_status(external_id)
- render/obtain_document()
- health()

## Impresora fiscal física
Ladino no tendrá desktop agent por defecto. Si una integración directa con hardware local fuese necesaria, se tratará como proyecto/arquitectura separada porque contradice el requisito de no distribuir desktop local y puede afectar homologación.

## Estrategia
Priorizar facturación digital cloud cuando el contribuyente y la norma lo permitan.
