# Correos de autenticación — Resend + Supabase

Los correos de verificación de cuenta y de recuperación de contraseña los
manda **Supabase Auth** (sus flujos ya son seguros y con caducidad), pero por
el **SMTP de Resend** y con las plantillas de esta carpeta. Nada de esto vive
en el código de la app; se configura UNA vez en los dos dashboards.

## 1. Resend — verificar el dominio (una vez)

Resend → Domains → Add domain → `ladinosystem.com`. Te dará 3 registros DNS
(SPF y DKIM) para agregar donde tengas el dominio. Sin esto, los correos
salen «en nombre de» un dominio no verificado y caen en spam.

Remitente sugerido: `Ladino <no-reply@ladinosystem.com>`.

## 2. Supabase — SMTP (una vez)

Dashboard del proyecto → Authentication → Emails → SMTP Settings → Enable:

| Campo | Valor |
| --- | --- |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | la API key de Resend (`re_…`) — la pegas TÚ; jamás va en el repo |
| Sender email | `no-reply@ladinosystem.com` |
| Sender name | `Ladino` |

Sin SMTP propio, Supabase manda con su remitente compartido y un límite de
~2 correos/hora: inservible en producción.

## 3. Supabase — plantillas

Authentication → Email Templates:

| Plantilla | Archivo | Asunto sugerido |
| --- | --- | --- |
| Confirm signup | `verificar-correo.html` | Verifica tu correo para entrar a Ladino |
| Reset password | `recuperar-contrasena.html` | Crea tu contraseña nueva de Ladino |

Se pega el HTML tal cual (las variables `{{ .ConfirmationURL }}` son de
Supabase). El logo se sirve desde
`https://app.ladinosystem.com/brand/ladino-logo.png` — público a propósito.

## 4. Supabase — URLs y verificación

- Authentication → URL Configuration → **Site URL**: `https://app.ladinosystem.com`
  y agrega la misma en **Redirect URLs**.
- Authentication → Providers → Email: **Confirm email = ON** (la web ya enseña
  «revisa tu correo» tras crear cuenta, y el enlace de recuperación abre la
  pantalla de contraseña nueva).

## Qué hace la web (ya construido, no requiere configuración)

- Crear cuenta: correo + contraseña + confirmación (mínimo 8, coincidencia
  validada); tras el alta enseña «revisa tu correo».
- «¿Olvidaste tu contraseña?»: pide el correo y avisa sin revelar si existe.
- El enlace del correo de recuperación abre la pantalla «Crea tu contraseña
  nueva» (con confirmación) antes de dejar pasar a la app.

En LOCAL nada de esto aplica: el stack usa Inbucket y no exige verificación.

## 4. Por qué el enlace lleva `token_hash` y no `{{ .ConfirmationURL }}` (2026-09-14)

`{{ .ConfirmationURL }}` apunta a `/auth/v1/verify`, que **gasta el enlace con solo abrirlo** (un
GET). Las vistas previas de Telegram/WhatsApp y los escáneres de correo corporativos abren los
enlaces por su cuenta, y se lo comían antes que la persona: en producción, un enlace de
recuperación lo consumió una IP de Telegram a los 20 segundos de enviarse, y la persona llegaba a
`/#error_code=otp_expired`.

Las plantillas llevan `{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=recovery|email`: la web
enseña «Continuar» y solo al pulsarlo llama a `verifyOtp`. Un bot no pulsa. (Código:
`apps/web/src/app/session.tsx`, `leerEnlace` y `ConfirmarEnlace`.)

**Orden al cambiar**: primero se despliega la web que entiende `token_hash`, después se pegan las
plantillas. Al revés, los enlaces nuevos caerían en una web que no los sabe leer.
