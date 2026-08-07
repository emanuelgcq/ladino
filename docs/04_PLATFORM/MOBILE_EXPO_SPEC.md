# App móvil Expo

## Objetivo
Operaciones móviles nativas sin convertir Ladino en desktop local.

## P0 mobile
- login/MFA;
- selector empresa/sucursal;
- clientes;
- productos/stock;
- ventas/cotizaciones;
- cobranzas;
- POS móvil si homologación lo permite;
- recepción inventario;
- conteo;
- dashboard;
- notificaciones;
- aprobación.

## Almacenamiento local
- SecureStore para tokens/secretos apropiados.
- SQLite para cache/sync queue si se habilita offline.
- Nunca guardar service role.
- Datos fiscales offline minimizados/cifrados.

## Versiones
Backend soporta N y N-1 mobile durante ventana definida.
Force upgrade cuando un build no sea compatible con protocolo fiscal.

## Homologación
`VALIDAR-SENIAT`: un build Expo que emite documentos debe estar incluido en alcance técnico de homologación.
