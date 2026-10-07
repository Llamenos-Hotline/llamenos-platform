---
title: Ke Kunche'e Problemas
description: Soluciones nuu problemas comunes nuu despliegue, aplicación escritorio, móvil, telefonía, ni operaciones criptográficas.
---

Yaa guía cubre problemas comunes ni soluciones a través todos modos despliegue Llámenos ni plataformas.

## Problemas despliegue Docker

### Contenedores no inician

**Variables entorno faltantes:**

Docker Compose valida todos servicios nuu inicio, incluso perfilados. Si ve errores sobre variables faltantes, asegure archivo `.env` incluye todos valores requeridos:

```bash
# Requerido nuu .env nuu Docker Compose
PG_PASSWORD=your_postgres_password
STORAGE_ACCESS_KEY=your_rustfs_access_key
STORAGE_SECRET_KEY=your_rustfs_secret_key
HMAC_SECRET=your_hmac_secret
ARI_PASSWORD=your_ari_password       # Requerido incluso si no usa Asterisk
BRIDGE_SECRET=your_bridge_secret     # Requerido incluso si no usa Asterisk
ADMIN_PUBKEY=your_admin_hex_pubkey
```

Incluso si no usa bridge Asterisk, Docker Compose valida definición servicio ni requiere `ARI_PASSWORD` ni `BRIDGE_SECRET` establecidos.

**Conflictos puerto:**

Si puerto ya está nuu uso, verifique qué proceso lo mantiene:

```bash
# Verificar qué usa puerto 8787 (Worker)
sudo lsof -i :8787

# Verificar qué usa puerto 5432 (PostgreSQL)
sudo lsof -i :5432

# Verificar qué usa puerto 9000 (RustFS)
sudo lsof -i :9000
```

Detenga proceso conflictivo o cambie mapeo puerto nuu `docker-compose.yml`.

### Errores conexión base datos

Si aplicación no puede conectar a PostgreSQL:

- Verifique `PG_PASSWORD` nuu `.env` coincide nuu usado cuando contenedor fue creado primero
- Verifique contenedor PostgreSQL está saludable: `docker compose ps`
- Si contraseña fue cambiada, puede necesitar eliminar volumen ni recrear: `docker compose down -v && docker compose up -d`

### Relé WebSocket no conecta

Relé WebSocket iin servicio núcleo, no opcional. Si relé no está corriendo:

```bash
# Verificar estado relé
docker compose logs WebSocket relay

# Reiniciar relé
docker compose restart WebSocket relay
```

Si relé falla iniciar, verifique conflictos puerto 7777 o permisos insuficientes nuu directorio datos.

### Errores almacenamiento RustFS / S3

- Verifique `STORAGE_ACCESS_KEY` ni `STORAGE_SECRET_KEY` son correctos
- Verifique contenedor RustFS está corriendo: `docker compose ps rustfs`
- Acceda consola RustFS nuu `http://localhost:9001` nuu verificar creación bucket

## Problemas despliegue Cloudflare

### Errores Durable Object

**"Durable Object no encontrado" o errores vinculación:**

- Ejecute `bun run deploy` (nunca `wrangler deploy` directamente) nuu asegurar vinculaciones DO correctas
- Verifique `wrangler.jsonc` nuu nombres clase DO correctos ni vinculaciones
- Después añadir nuevo DO, debe desplegar antes de ke esté disponible

**Límites almacenamiento DO:**

Cloudflare Durable Objects tienen límite 128 KB por par clave-valor. Si ve errores almacenamiento:

- Asegure contenido nota no excede límite (notas muy grandes nuu muchos adjuntos)
- Verifique sobres ECIES no están siendo duplicados

### Errores Worker (respuestas 500)

Verifique logs Worker:

```bash
bunx wrangler tail
```

Causas comunes:
- Secretos faltantes (use `bunx wrangler secret list` nuu verificar)
- Formato `ADMIN_PUBKEY` incorrecto (debe ser 64 caracteres hex, sin prefijo `npub`)
- Rate limiting nuu tier gratuito (1,000 solicitudes/minuto nuu Workers Free)

### Despliegue falla nuu errores "Pages deploy"

Nunca ejecute `wrangler pages deploy` o `wrangler deploy` directamente. Siempre use scripts `package.json` raíz:

```bash
bun run deploy          # Desplegar todo (app + sitio marketing)
bun run deploy:site     # Desplegar solo sitio marketing
```

Ejecutar `wrangler pages deploy dist` desde directorio incorrecto despliega construcción Vite app a Pages en lugar sitio Astro, rompiendo sitio marketing nuu errores 404.

## Problemas aplicación escritorio

### Auto-actualización no funciona

Aplicación escritorio usa actualizador Tauri nuu verificar nuevas versiones. Si actualizaciones no se detectan:

- Verifique conexión internet
- Verifique ke endpoint actualización es alcanzable: `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- Nu Linux, auto-actualización AppImage requiere ke archivo tenga permisos escritura nuu directorio
- Nu macOS, aplicación debe estar nuu `/Applications` (no corriendo desde DMG directamente)

Nu actualizar manualmente, descargue última versión desde página [Descargar](/download).

### Desbloqueo PIN falla

Si PIN es rechazado nuu aplicación escritorio:

- Asegure está ingresando PIN correcto (no hay recuperación "olvidé PIN")
- PINs son sensibles mayúsculas si contienen letras
- Si olvidó PIN, debe reingresar nsec nuu establecer nuevo. Notas cifradas permanecen accesibles porque están vinculadas a identidad, no a PIN
- Tauri Stronghold cifra nsec nuu clave derivada PIN (PBKDF2). PIN incorrecto produce descifrado inválido, no mensaje error — aplicación detecta yaa verificando clave pública derivada

### Recuperación clave

Si perdió acceso a dispositivo:

1. Use nsec (ke debería haber guardado nuu gestor contraseñas) nuu iniciar sesión nuu nuevo dispositivo
2. Si registró passkey WebAuthn, puede usarlo nuu nuevo dispositivo en lugar
3. Notas cifradas se almacenan servidor — una vez inicia sesión nuu misma identidad, puede descifrarlas
4. Si perdió nsec ni passkey, contacte ña'a. No pueden recuperar nsec, pero pueden crear nueva identidad. Notas cifradas nuu identidad anterior ya no serán legibles

### Aplicación no inicia (ventana en blanco)

- Verifique ke sistema cumple requisitos mínimos (ver [Descargar](/download))
- Nu Linux, asegure WebKitGTK está instalado: `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) o equivalente
- Intente lanzar desde terminal nuu ver salida error: `./llamenos` (AppImage) o verifique logs sistema
- Si usa Wayland, intente nuu `GDK_BACKEND=x11` como fallback

### Conflicto instancia única

Llámenos impone modo instancia única. Si aplicación dice ke ya está corriendo pero no puede encontrar ventana:

- Verifique procesos fondo: `ps aux | grep llamenos`
- Mate procesos huérfanos: `pkill llamenos`
- Nu Linux, verifique archivo lock obsoleto ni elimínelo si aplicación se bloqueó

## Problemas aplicación móvil

### Fallos aprovisionamiento

Ver [Guía Móvil](/docs/mobile-guide#troubleshooting-mobile-issues) nuu solución problemas aprovisionamiento detallada.

Causas comunes:
- Código QR expirado (tokens expiran después 5 minutos)
- Sin conexión internet nuu cualquier dispositivo
- Aplicación escritorio ni móvil corriendo versiones protocolo diferentes

### Notificaciones push no llegan

- Verifique permisos notificación otorgados nuu ajustes SO
- Nu Android, verifique ke optimización batería no está matando aplicación nuu fondo
- Nu iOS, verifique ke Background App Refresh está habilitado nuu Llámenos
- Verifique ke tiene turno activo ni no está nuu descanso

## Problemas telefonía

### Configuración webhook Twilio

Si llamadas no enrutan a voluntarios:

1. Verifique URLs webhook correctas nuu consola Twilio:
   - Webhook voz: `https://your-worker.your-domain.com/telephony/incoming` (POST)
   - Callback estado: `https://your-worker.your-domain.com/telephony/status` (POST)
2. Verifique ke credenciales Twilio nuu ajustes coinciden nuu consola:
   - Account SID
   - Auth Token
   - Número teléfono (debe incluir código país, ej., `+1234567890`)
3. Verifique depurador Twilio nuu errores: [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Configuración número

- Número teléfono debe ser número propiedad Twilio o ID llamante verificado
- Nuu desarrollo local, use Cloudflare Tunnel o ngrok nuu exponer Worker local a Twilio
- Verifique configuración voz número apunta a URL webhook, no TwiML Bin por defecto

### Llamadas conectan pero no hay audio

- Asegure ke servidores media proveedor telefonía pueden alcanzar teléfono voluntario
- Verifique problemas NAT/firewall bloqueando tráfico RTP
- Si usa WebRTC, verifique ke servidores STUN/TURN están configurados correctamente
- Algunas VPNs bloquean tráfico VoIP — intente sin VPN

### Mensajes SMS/WhatsApp no llegan

- Verifique URLs webhook mensajería configuradas correctamente nuu consola proveedor
- Nuu WhatsApp, asegure token verificación webhook Meta coincide nuu ajustes
- Verifique ke canal mensajería está habilitado nuu **Configuración Ña'a > Canales**
- Nuu Signal, verifique bridge signal-cli está corriendo ni configurado nuu reenviar a webhook

## Errores cripto

### Errores mismatch clave

**"Fallo descifrar" o "Clave inválida" al abrir notas:**

- Esto generalmente significa ke nota fue cifrada nuu identidad diferente a la ke está usando
- Verifique está usando nsec correcto (verifique npub nuu Configuración coincide nuu ke ña'a ve)
- Si recientemente recreó identidad, notas antiguas cifradas nuu clave pública anterior no serán descifrables nuu nueva clave

**"Firma inválida" nuu inicio sesión:**

- Nsec puede estar corrupta — intente reingresarla desde gestor contraseñas
- Asegure nsec completa pegada (empieza nuu `nsec1`, 63 caracteres total)
- Verifique espacios en blanco extra o caracteres nueva línea

### Fallos verificación firma

Si eventos hub fallan verificación firma:

- Verifique ke reloj sistema está sincronizado (NTP). Gran desviación reloj puede causar problemas nuu marcas tiempo eventos
- Verifique ke relé WebSocket no está reenviando eventos desde pubkeys desconocidos
- Reinicie aplicación nuu re-obtener lista miembros hub actual

### Errores sobre ECIES

**"Fallo desenvolver clave" nuu descifrado nota:**

- Sobre ECIES puede haber sido creado nuu clave pública incorrecta
- Esto puede pasar si ña'a añadió voluntario nuu error nuu pubkey
- Ña'a debería verificar pubkey voluntario ni re-invitar si es necesario

**"Longitud ciphertext inválida":**

- Esto indica corrupción datos, posiblemente desde respuesta red truncada
- Reintente operación. Si persiste, datos cifrados pueden estar permanentemente corruptos
- Verifique problemas proxy o CDN ke puedan truncar cuerpos respuesta

### Errores clave hub

**"Fallo descifrar evento hub":**

- Clave hub puede haber sido rotada desde última conexión
- Cierre ni reabra aplicación nuu obtener última clave hub
- Si fue recientemente removido ni re-añadido al hub, clave puede haber rotado durante ausencia

## Obtener ayuda

Si su problema no está cubierto aquí:

- Verifique [GitHub Issues](https://github.com/rhonda-rodododo/llamenos-platform/issues) nuu bugs conocidos ni workarounds
- Busque issues existentes antes crear nuevo
- Al reportar bug, incluya: modo despliegue (Cloudflare/Docker/Kubernetes), plataforma (Escritorio/Móvil), ni cualquier mensaje error consola navegador o terminal
