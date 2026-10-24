---
title: Solucion de problemas
description: Soluciones para problemas comunes con despliegue, la aplicacion de escritorio, aplicacion movil, telefonia y operaciones criptograficas.
---

Esta guia cubre problemas comunes y sus soluciones en todos los modos de despliegue y plataformas de Llamenos.

## Problemas de despliegue Docker

### Los containers no inician

**Variables de entorno faltantes:**

Docker Compose valida todos los servicios al inicio, incluso los perfilados. Si ves errores sobre variables faltantes, asegurate de que tu archivo `.env` incluya todos los valores requeridos:

```bash
# Requerido en .env para Docker Compose
PG_PASSWORD=tu_contraseña_postgres
STORAGE_ACCESS_KEY=tu_clave_de_acceso_rustfs
STORAGE_SECRET_KEY=tu_clave_secreta_rustfs
HMAC_SECRET=tu_secreto_hmac
ARI_PASSWORD=tu_contraseña_ari       # Requerido incluso sin usar Asterisk
BRIDGE_SECRET=tu_secreto_bridge     # Requerido incluso sin usar Asterisk
ADMIN_PUBKEY=tu_pubkey_hex_admin
```

Incluso si no estas usando el bridge de Asterisk, Docker Compose valida su definicion de servicio y requiere que `ARI_PASSWORD` y `BRIDGE_SECRET` esten definidos.

**Conflictos de puerto:**

Si un puerto ya esta en uso, verifica que proceso lo esta usando:

```bash
# Verificar que esta usando el puerto 8787 (Worker)
sudo lsof -i :8787

# Verificar que esta usando el puerto 5432 (PostgreSQL)
sudo lsof -i :5432

# Verificar que esta usando el puerto 9000 (RustFS)
sudo lsof -i :9000
```

Detiene el proceso conflictivo o cambia el mapeo de puertos en `docker-compose.yml`.

### Errores de conexion con la base de datos

Si la aplicacion no puede conectarse a PostgreSQL:

- Verifica que el `PG_PASSWORD` en `.env` coincida con el que se uso cuando el container fue creado por primera vez
- Verifica que el container de PostgreSQL este sano: `docker compose ps`
- Si la contraseña fue cambiada, puede que necesites eliminar el volumen y recrear: `docker compose down -v && docker compose up -d`

### El relay WebSocket relay no conecta

El relay WebSocket es un servicio esencial, no opcional. Si el relay no esta ejecutandose:

```bash
# Verificar estado del relay
docker compose logs WebSocket relay

# Reiniciar el relay
docker compose restart WebSocket relay
```

Si el relay no inicia, verifica conflictos en el puerto 7777 o permisos insuficientes en el directorio de datos.

### Errores de almacenamiento RustFS / S3

- Verifica que `STORAGE_ACCESS_KEY` y `STORAGE_SECRET_KEY` sean correctos
- Verifica que el container de RustFS este ejecutandose: `docker compose ps rustfs`
- Accede a la consola de RustFS en `http://localhost:9001` para verificar la creacion del bucket

## Problemas de despliegue Cloudflare

### Errores de Durable Object

**"Durable Object not found" o errores de binding:**

- Ejecuta `bun run deploy` (nunca `wrangler deploy` directamente) para asegurar que los bindings de DO esten correctos
- Verifica `wrangler.jsonc` para nombres de clase y bindings de DO correctos
- Despues de agregar un nuevo DO, debes hacer deploy antes de que este disponible

**Limites de almacenamiento de DO:**

Cloudflare Durable Objects tiene un limite de 128 KB por par clave-valor. Si ves errores de almacenamiento:

- Asegurate de que el contenido de las notas no exceda el limite (notas muy grandes con muchos adjuntos)
- Verifica que los sobres ECIES no esten duplicados

### Errores del Worker (respuestas 500)

Verifica los logs del Worker:

```bash
bunx wrangler tail
```

Causas comunes:
- Secrets faltantes (usa `bunx wrangler secret list` para verificar)
- Formato incorrecto de `ADMIN_PUBKEY` (debe ser 64 caracteres hexadecimales, sin prefijo `npub`)
- Limite de tasa en el plan gratuito (1,000 solicitudes/minuto en Workers Free)

### El despliegue falla con errores "Pages deploy"

Nunca ejecutes `wrangler pages deploy` o `wrangler deploy` directamente. Siempre usa los scripts del `package.json` raiz:

```bash
bun run deploy          # Desplegar todo (app + sitio de marketing)
bun run deploy:site     # Desplegar solo el sitio de marketing
```

Ejecutar `wrangler pages deploy dist` desde el directorio incorrecto despliega el build de la app Vite en Pages en lugar del sitio Astro, rompiendo el sitio de marketing con errores 404.

## Problemas de la aplicacion de escritorio

### La actualizacion automatica no funciona

La aplicacion de escritorio usa el Tauri updater para buscar nuevas versiones. Si las actualizaciones no se detectan:

- Verifica tu conexion a internet
- Verifica que el endpoint de actualizacion sea accesible: `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- En Linux, AppImage requiere permisos de escritura en su directorio para actualizacion automatica
- En macOS, la aplicacion debe estar en `/Applications` (no ejecutandose directamente desde el DMG)

Para actualizar manualmente, descarga la version mas reciente de la pagina de [Descarga](/download).

### El desbloqueo por PIN falla

Si tu PIN es rechazado en la aplicacion de escritorio:

- Asegurate de estar ingresando el PIN correcto (no hay recuperacion de "olvide mi PIN")
- Los PINs distinguen mayusculas y minusculas si contienen letras
- Si olvidaste tu PIN, deberas reingresar tu nsec para establecer uno nuevo. Tus notas cifradas permanecen accesibles porque estan vinculadas a tu identidad, no a tu PIN
- El Tauri Stronghold cifra tu nsec con la clave derivada del PIN (PBKDF2). Un PIN incorrecto produce un descifrado invalido, no un mensaje de error -- la aplicacion detecta esto verificando la clave publica derivada

### Recuperacion de claves

Si perdiste acceso a tu dispositivo:

1. Usa tu nsec (que deberias haber almacenado en un administrador de contrasenas) para iniciar sesion en un nuevo dispositivo
2. Si registraste una passkey WebAuthn, puedes usarla en el nuevo dispositivo
3. Tus notas cifradas estan almacenadas en el servidor -- una vez que inicies sesion con la misma identidad, podras descifrarlas
4. Si perdiste tanto tu nsec como tu passkey, contacta a tu administrador. No pueden recuperar tu nsec, pero pueden crear una nueva identidad para ti. Las notas cifradas para tu identidad anterior ya no seran legibles por ti

### La aplicacion no inicia (ventana en blanco)

- Verifica que tu sistema cumpla los requisitos minimos (ver [Descarga](/download))
- En Linux, asegurate de que WebKitGTK este instalado: `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) o equivalente
- Intenta iniciar desde la terminal para ver la salida de error: `./llamenos` (AppImage) o verifica los logs del sistema
- Si usas Wayland, intenta con `GDK_BACKEND=x11` como alternativa

### Conflicto de instancia unica

Llamenos impone el modo de instancia unica. Si la aplicacion dice que ya esta ejecutandose pero no puedes encontrar la ventana:

- Verifica procesos en segundo plano: `ps aux | grep llamenos`
- Termina procesos huerfanos: `pkill llamenos`
- En Linux, verifica si hay un archivo de bloqueo obsoleto y eliminalo si la aplicacion se cerro inesperadamente

## Problemas de la aplicacion movil

### Fallos de aprovisionamiento

Consulta la [Guia de la aplicacion movil](/docs/mobile-guide#solucion-de-problemas-de-la-aplicacion-movil) para solucion detallada de problemas de aprovisionamiento.

Causas comunes:
- Codigo QR expirado (los tokens expiran despues de 5 minutos)
- Sin conexion a internet en cualquiera de los dispositivos
- Aplicacion de escritorio y aplicacion movil ejecutando versiones diferentes del protocolo

### Las notificaciones push no llegan

- Verifica que los permisos de notificacion esten concedidos en la configuracion del SO
- En Android, verifica que la optimizacion de bateria no este cerrando la aplicacion en segundo plano
- En iOS, verifica que la Actualizacion de Apps en Segundo Plano este habilitada para Llamenos
- Verifica que tengas un turno activo y no estes en pausa

## Problemas de telefonia

### Configuracion de webhook de Twilio

Si las llamadas no se enrutan a los voluntarios:

1. Verifica que las URLs de webhook esten correctas en la consola de Twilio:
   - Webhook de voz: `https://tu-worker.tu-dorustfs.com/telephony/incoming` (POST)
   - Status callback: `https://tu-worker.tu-dorustfs.com/telephony/status` (POST)
2. Verifica que las credenciales de Twilio en tu configuracion coincidan con la consola:
   - Account SID
   - Auth Token
   - Numero de telefono (debe incluir codigo de pais, ej: `+1234567890`)
3. Verifica el debugger de Twilio para errores: [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Configuracion de numero

- El numero de telefono debe ser un numero propiedad de Twilio o un caller ID verificado
- Para desarrollo local, usa un Cloudflare Tunnel o ngrok para exponer tu Worker local a Twilio
- Verifica que la configuracion de voz del numero apunte a tu URL de webhook, no al TwiML Bin predeterminado

### Las llamadas conectan pero sin audio

- Asegurate de que los servidores de medios del proveedor de telefonia puedan alcanzar el telefono del voluntario
- Verifica problemas de NAT/firewall bloqueando trafico RTP
- Si usas WebRTC, verifica que los servidores STUN/TURN esten configurados correctamente
- Algunas VPN bloquean trafico VoIP -- intenta sin la VPN

### Los mensajes SMS/WhatsApp no llegan

- Verifica que las URLs de webhook de mensajeria esten configuradas correctamente en la consola de tu proveedor
- Para WhatsApp, asegurate de que el token de verificacion del webhook de Meta coincida con tu configuracion
- Verifica que el canal de mensajeria este habilitado en **Configuracion de Admin > Canales**
- Para Signal, verifica que el bridge signal-cli este ejecutandose y configurado para reenviar a tu webhook

## Errores de criptografia

### Errores de incompatibilidad de clave

**"Fallo al descifrar" o "Clave invalida" al abrir notas:**

- Esto generalmente significa que la nota fue cifrada para una identidad diferente a la que tienes en sesion
- Verifica que estes usando el nsec correcto (verifica que tu npub en Configuracion coincida con lo que el administrador ve)
- Si recreaste recientemente tu identidad, notas antiguas cifradas para tu clave publica anterior no seran descifrables con la nueva clave

**"Firma invalida" al iniciar sesion:**

- El nsec puede estar corrupto -- intenta reingresarlo desde tu administrador de contrasenas
- Asegurate de que el nsec completo fue pegado (comienza con `nsec1`, 63 caracteres en total)
- Verifica si hay espacios en blanco o caracteres de nueva linea adicionales

### Fallos en la verificacion de firma

Si los eventos del hub fallan en la verificacion de firma:

- Verifica que el reloj del sistema este sincronizado (NTP). Gran desvio de reloj puede causar problemas con timestamps de eventos
- Verifica que el relay WebSocket no este retransmitiendo eventos de pubkeys desconocidas
- Reinicia la aplicacion para buscar nuevamente la lista actual de miembros del hub

### Errores de sobre ECIES

**"Fallo al desenvolver clave" en el descifrado de notas:**

- El sobre ECIES puede haber sido creado con una clave publica incorrecta
- Esto puede suceder si el administrador agrego un voluntario con un error en la pubkey
- El administrador debe verificar la clave publica del voluntario y reinvitar si es necesario

**"Longitud de texto cifrado invalida":**

- Esto indica corrupcion de datos, posiblemente de una respuesta de red truncada
- Intenta nuevamente la operacion. Si persiste, los datos cifrados pueden estar permanentemente corruptos
- Verifica problemas de proxy o CDN que puedan truncar cuerpos de respuesta

### Errores de clave del hub

**"Fallo al descifrar evento del hub":**

- La clave del hub puede haber sido rotada desde tu ultima conexion
- Cierra y reabre la aplicacion para buscar la clave del hub mas reciente
- Si fuiste recientemente removido y readicionado al hub, la clave pudo haber rotado durante tu ausencia

## Obtener ayuda

Si tu problema no esta cubierto aqui:

- Revisa las [Issues de GitHub](https://github.com/rhonda-rodododo/llamenos-platform/issues) para bugs conocidos y soluciones alternativas
- Busca en issues existentes antes de crear uno nuevo
- Al reportar un bug, incluye: tu modo de despliegue (Cloudflare/Docker/Kubernetes), plataforma (Escritorio/Movil) y cualquier mensaje de error de la consola del navegador o terminal
