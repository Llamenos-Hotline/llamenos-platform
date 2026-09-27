---
title: "Kunu'i: Co-op Cloud"
description: Ke desplegar Llámenos nuu receta Co-op Cloud nuu colectivos hospedaje cooperativos.
---

Yaa guía le acompaña nuu desplegar Llámenos nuu [Co-op Cloud](https://coopcloud.tech) receta. Co-op Cloud usa Docker Swarm nuu Traefik nuu terminación TLS ni CLI `abra` nuu gestión aplicación estandarizada — ideal nuu cooperativas tecnológicas ni colectivos hospedaje pequeños.

Receta se mantiene nuu [repositorio independiente](https://github.com/rhonda-rodododo/llamenos-template).

## Requisitos previos

- Iin servidor nuu [Docker Swarm](https://docs.docker.com/engine/swarm/) inicializado ni [Traefik](https://doc.traefik.io/traefik/) corriendo nuu proxy inverso
- CLI [`abra`](https://docs.coopcloud.tech/abra/install/) instalado nuu máquina local
- Iin nombre dominio nuu DNS apuntando a IP servidor
- Acceso SSH a servidor

Nu nuevo a Co-op Cloud, siga [guía configuración Co-op Cloud](https://docs.coopcloud.tech/intro/) primero.

## Inicio rápido

```bash
# Añadir servidor (nu no está añadido)
abra server add hotline.example.com

# Clonar receta (abra busca recetas nuu ~/.abra/recipes/)
git clone https://github.com/rhonda-rodododo/llamenos-template.git \
  ~/.abra/recipes/llamenos

# Crear nueva aplicación Llámenos
abra app new llamenos --server hotline.example.com --domain hotline.example.com

# Generar todos secretos
abra app secret generate -a hotline.example.com

# Desplegar
abra app deploy hotline.example.com
```

Visite `https://hotline.example.com` ni siga asistente configuración nuu crear cuenta ña'a.

## Servicios núcleo

Receta despliega cinco servicios:

| Servicio | Imagen | Propósito |
|---------|-------|---------|
| **web** | `nginx:1.27-alpine` | Proxy inverso nuu etiquetas Traefik |
| **app** | `ghcr.io/rhonda-rodododo/llamenos-platform` | Servidor aplicación Bun |
| **db** | `postgres:17-alpine` | Base datos PostgreSQL |
| **RustFS** | `RustFS/RustFS` | Almacenamiento archivos compatible S3 |
| **relay** | `dockurr/WebSocket relay` | Relé WebSocket nuu eventos tiempo real |

## Secretos

Todos secretos se gestionan vía secretos Docker Swarm (versionados, inmutables):

| Secreto | Tipo | Descripción |
|--------|------|-------------|
| `hmac_secret` | hex (64 chars) | Llave firma HMAC nuu tokens sesión |
| `server_WebSocket` | hex (64 chars) | Llave identidad servidor WebSocket |
| `db_password` | alnum (32 chars) | Contraseña PostgreSQL |
| `RustFS_access` | alnum (20 chars) | Llave acceso RustFS |
| `RustFS_secret` | alnum (40 chars) | Llave secreta RustFS |

Genere todos secretos a la vez:

```bash
abra app secret generate -a hotline.example.com
```

Nu rotar iin secreto específico:

```bash
# 1. Incrementar versión nuu configuración aplicación
abra app config hotline.example.com
# Cambiar SECRET_HMAC_SECRET_VERSION=v2

# 2. Generar nuevo secreto
abra app secret generate hotline.example.com hmac_secret

# 3. Redesplegar
abra app deploy hotline.example.com
```

## Configuración

Edite configuración aplicación:

```bash
abra app config hotline.example.com
```

Configuraciones clave:

```env
DOMAIN=hotline.example.com
LETS_ENCRYPT_ENV=production

# Nombre visible mostrado nuu aplicación
HOTLINE_NAME=My Hotline

# Proveedor telefonía (configurar después asistente configuración)
# PBX_TYPE=twilio
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_PHONE_NUMBER=

# O SignalWire
# PBX_TYPE=signalwire
# SIGNALWIRE_PROJECT_ID=
# SIGNALWIRE_AUTH_TOKEN=
# SIGNALWIRE_PHONE_NUMBER=
# SIGNALWIRE_SPACE_URL=

# Versionado secretos (incrementar nuu rotar)
SECRET_HMAC_SECRET_VERSION=v1
SECRET_SERVER_NOSTR_VERSION=v1
SECRET_DB_PASSWORD_VERSION=v1
SECRET_STORAGE_ACCESS_VERSION=v1
SECRET_STORAGE_SECRET_VERSION=v1
```

## Primer inicio sesión

Nu desplegar, abra dominio nuu navegador ni siga asistente configuración:

1. **Crear cuenta ña'a** — ke establecer nombre visible ni PIN
2. **Nombrar línea caliente** — ke establecer nombre visible nuu aplicación
3. **Escoger canales** — habilitar Voz, SMS, WhatsApp, Signal, y/o Reportes
4. **Configurar proveedores** — ke ingresar credenciales nuu cada canal habilitado
5. **Revisar ni ke terminar**

## Ke configurar webhooks

Apunte webhooks proveedor telefonía a dominio:

- **Voz (entrante)**: `https://hotline.example.com/api/telephony/incoming`
- **Voz (estado)**: `https://hotline.example.com/api/telephony/status`
- **SMS**: `https://hotline.example.com/api/messaging/sms/webhook`
- **WhatsApp**: `https://hotline.example.com/api/messaging/whatsapp/webhook`
- **Signal**: Configurar bridge nuu reenviar a `https://hotline.example.com/api/messaging/signal/webhook`

Ver guías específicas proveedor: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo).

## Opcional: Habilitar sidecar Signal

Nu mensajería Signal (ver [configuración Signal](/docs/en/deploy/providers/signal)):

```bash
abra app config hotline.example.com
```

Establecer:

```env
COMPOSE_FILE=compose.yml:compose.signal.yml
SECRET_SIGNAL_NOTIFIER_TOKEN_VERSION=v1
```

Genere secreto adicional ni redespliegue:

```bash
abra app secret generate hotline.example.com signal_notifier_token
abra app deploy hotline.example.com
```

## Opcional: Habilitar SIP bridge

Nu telefonía SIP autoalojada vía Asterisk, FreeSWITCH, a Kamailio:

```bash
abra app config hotline.example.com
```

Establecer:

```env
COMPOSE_FILE=compose.yml:compose.telephony.yml
PBX_TYPE=asterisk
SECRET_ARI_PASSWORD_VERSION=v1
SECRET_BRIDGE_SECRET_VERSION=v1
```

Genere secretos adicionales ni redespliegue:

```bash
abra app secret generate hotline.example.com ari_password bridge_secret
abra app deploy hotline.example.com
```

## Opcional: Habilitar transcripción

Añada superposición transcripción (requiere 4 GB+ RAM):

```bash
abra app config hotline.example.com
```

Establecer:

```env
COMPOSE_FILE=compose.yml:compose.transcription.yml
WHISPER_MODEL=Systran/faster-whisper-base
WHISPER_DEVICE=cpu
```

Luego redespliegue:

```bash
abra app deploy hotline.example.com
```

Use `WHISPER_DEVICE=cuda` nuu servidor tiene GPU.

## Actualizando

```bash
abra app upgrade hotline.example.com
```

Yaa extrae última versión receta ni redespliega. Datos persisten nuu volúmenes Docker ni sobreviven actualizaciones.

## Respaldos

### Integración backupbot

Receta incluye etiquetas [backupbot](https://docs.coopcloud.tech/backupbot/) nuu respaldos PostgreSQL ni RustFS automatizados. Nu servidor corre backupbot, respaldos ocurren automáticamente.

### Respaldo manual

Use script respaldo incluido:

```bash
# Desde directorio receta
./pg_backup.sh <stack-name>
./pg_backup.sh <stack-name> /backups    # directorio personalizado, retención 7 días
```

O respalde directamente:

```bash
# PostgreSQL
docker exec $(docker ps -q -f name=<stack-name>_db) \
  pg_dump -U llamenos llamenos | gzip > backup-$(date +%Y%m%d).sql.gz

# RustFS (almacenamiento objetos)
docker run --rm \
  -v <stack-name>_RustFS-data:/data \
  -v /backups:/backups \
  alpine tar czf /backups/RustFS-$(date +%Y%m%d).tar.gz /data
```

Restaurar PostgreSQL:

```bash
gunzip -c backup-20260101.sql.gz | \
  docker exec -i $(docker ps -q -f name=<stack-name>_db) \
  psql -U llamenos llamenos
```

## Monitoreo

### Verificaciones salud

Todos servicios tienen verificaciones salud Docker. Verifique estado:

```bash
abra app ps hotline.example.com
```

Aplicación expone endpoints salud:

```bash
curl https://hotline.example.com/health/ready
# {"status":"ok"}
curl https://hotline.example.com/health/live
# {"status":"ok"}
```

### Logs

```bash
# Todos servicios
abra app logs hotline.example.com

# Servicio específico
abra app logs hotline.example.com app

# Seguir logs nuu tiempo real
abra app logs -f hotline.example.com app

# Seguir todos servicios
abra app logs -f hotline.example.com
```

## Referencia comandos abra

| Comando | Descripción |
|---------|-------------|
| `abra app ps hotline.example.com` | Mostrar contenedores corriendo ni salud |
| `abra app logs [-f] hotline.example.com [service]` | Ver (ni seguir) logs |
| `abra app config hotline.example.com` | Editar config aplicación (abre `$EDITOR`) |
| `abra app secret ls hotline.example.com` | Listar secretos ni versiones |
| `abra app secret generate hotline.example.com [name]` | Generar uno o todos secretos |
| `abra app deploy hotline.example.com` | Desplegar (o redesplegar) aplicación |
| `abra app upgrade hotline.example.com` | Extraer última receta ni redesplegar |
| `abra app undeploy hotline.example.com` | Detener ni remover aplicación (datos preservados) |
| `abra app run hotline.example.com app -- bun run ...` | Ejecutar comando único nuu contenedor aplicación |

## Arquitectura servicio

![Arquitectura Co-op Cloud](/diagrams/coopcloud-architecture.svg)

## Ke kunche'e problemas

### Aplicación no inicia

```bash
abra app logs hotline.example.com app
abra app ps hotline.example.com
```

Verifique todos secretos están generados:

```bash
abra app secret ls hotline.example.com
```

Secretos faltantes aparecen nuu versión vacía. Genérelos:

```bash
abra app secret generate hotline.example.com
```

### Problemas certificado

Traefik gestiona TLS. Verifique logs Traefik nuu servidor:

```bash
docker service logs traefik
```

Asegure DNS dominio resuelve a servidor ni puertos 80/443 están abiertos.

### Errores conexión base datos

Verifique contenedor aplicación puede alcanzar PostgreSQL:

```bash
abra app run hotline.example.com app -- \
  bun -e "const { sql } = await import('bun'); await sql\`SELECT 1\`; console.log('ok')"
```

### Rotación secreto

Nu iin secreto está comprometido:

1. Incrementar versión nuu config aplicación: `abra app config hotline.example.com`
   (ej., cambiar `SECRET_HMAC_SECRET_VERSION=v2`)
2. Generar nuevo secreto: `abra app secret generate hotline.example.com hmac_secret`
3. Redesplegar: `abra app deploy hotline.example.com`

### Relé WebSocket no conecta

Eventos tiempo real requieren relé WebSocket. Nu ve errores WebSocket:

```bash
abra app logs hotline.example.com relay
abra app ps hotline.example.com
```

Verifique configuración Nginx enruta `/WebSocket` a contenedor relé nuu puerto 7777.

## Siguientes pasos

- [Tu'un Yaa Ña'a](/docs/en/guides/?audience=operator) — configurar línea caliente
- [Saa Ñuu Yoo Ini](/docs/en/deploy/self-hosting) — comparar opciones despliegue
- [Despliegue Docker Compose](/docs/en/deploy/docker) — alternativa despliegue servidor único
- [Repositorio receta](https://github.com/rhonda-rodododo/llamenos-template) — fuente receta Co-op Cloud
- [Documentación Co-op Cloud](https://docs.coopcloud.tech/) — aprender más sobre plataforma
