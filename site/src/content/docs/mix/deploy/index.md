---
title: Kunta'an Ini
description: Ke kunu'i línea caliente Llámenos nuu minutos.
---

Ke tener línea caliente Llámenos funcionando localmente a nuu servidor. Solo se necesita Docker — no Node.js, Bun, a otros runtimes nuu host.

## Ke'ni funciona

Nu alguien llama a número línea caliente, Llámenos enruta llamada a todos usuarios de turno simultáneamente. Primer usuario ke responde se conecta, ni otros dejan sonar. Nu terminar llamada, usuario puede guardar notas cifradas nuu conversación.

![Enrutamiento Llamadas](/diagrams/call-routing.svg)

Mismo enrutamiento aplica a SMS, WhatsApp, Signal, ni otros canales mensajería — aparecen nuu iin vista **Conversaciones** unificada.

## Requisitos previos

- [Docker](https://docs.docker.com/get-docker/) nuu Docker Compose v2
- `openssl` (preinstalado nuu mayoría sistemas Linux ni macOS)
- Git

## Inicio rápido

```bash
git clone https://github.com/rhonda-rodododo/llamenos-platform.git
cd llamenos-platform
./scripts/docker-setup.sh
```

Yaa genera todos secretos requeridos, construye aplicación, ni inicia servicios. Una vez completo, visite **http://localhost:8000** ni siga asistente configuración:

1. **Crear cuenta ña'a** — ke establecer nombre visible ni PIN
2. **Nombrar línea caliente** — ke establecer nombre visible nuu aplicación
3. **Escoger canales** — habilitar Voz, SMS, WhatsApp, Signal, y/o Reportes
4. **Configurar proveedores** — ke ingresar credenciales nuu cada canal habilitado
5. **Revisar ni ke terminar**

## Despliegue producción

Nu servidor nuu dominio real ni TLS automático:

```bash
./scripts/docker-setup.sh --domain hotline.yourorg.com --email admin@yourorg.com
```

Caddy automáticamente provisiona certificados TLS Let's Encrypt. Asegurar puertos 80 ni 443 estén abiertos. Bandera `--domain` activa superposición Docker Compose producción, ke añade TLS, rotación logs, ni límites recursos.

Ver guía despliegue [Docker Compose](/docs/en/deploy/docker) nuu detalles completos nuu endurecimiento servidor, respaldos, monitoreo, ni servicios opcionales.

## Servicios núcleo

Configuración Docker inicia yaa servicios núcleo:

| Servicio | Propósito | Puerto |
|---------|---------|------|
| **app** | Aplicación Llámenos (Bun) | 3000 (interno) |
| **postgres** | Base datos PostgreSQL | 5432 (interno) |
| **caddy** | Proxy inverso + TLS automático | 8000 (local), 80/443 (producción) |
| **RustFS** | Almacenamiento archivos compatible S3 | 9000 (interno) |
| **relé WebSocket** | Relé WebSocket nuu eventos tiempo real | 7777 (interno) |

Perfiles opcionales añaden: signal-notifier sidecar, sip-bridge (Asterisk/FreeSWITCH/Kamailio), Ollama/vLLM inferencia, monitoreo Prometheus.

## Sondas salud

Aplicación expone dos endpoints salud usados por verificaciones salud Docker ni sondas Kubernetes:

- `GET /health/ready` — devuelve 200 nuu aplicación está lista nuu servir tráfico (BD conectada, migraciones aplicadas)
- `GET /health/live` — devuelve 200 nuu proceso aplicación está vivo

## Ke configurar webhooks

Nu desplegar, apunte webhooks proveedor telefonía a URL despliegue:

| Webhook | URL |
|---------|-----|
| Voz (entrante) | `https://your-domain/api/telephony/incoming` |
| Voz (estado) | `https://your-domain/api/telephony/status` |
| SMS | `https://your-domain/api/messaging/sms/webhook` |
| WhatsApp | `https://your-domain/api/messaging/whatsapp/webhook` |
| Signal | Reenviar a `https://your-domain/api/messaging/signal/webhook` |

Nu configuración específica proveedor: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo), [Asterisk](/docs/en/deploy/providers/asterisk), [SMS](/docs/en/deploy/providers/sms), [WhatsApp](/docs/en/deploy/providers/whatsapp), [Signal](/docs/en/deploy/providers/signal).

## Siguientes pasos

- [Despliegue Docker Compose](/docs/en/deploy/docker) — guía despliegue producción completo nuu respaldos ni monitoreo
- [Despliegue Kubernetes](/docs/en/deploy/kubernetes) — ke desplegar nuu Helm
- [Despliegue Co-op Cloud](/docs/en/deploy/coopcloud) — ke desplegar nuu colectivos hospedaje cooperativos
- [Proveedores Telefonía](/docs/en/deploy/providers/) — comparar proveedores voz
- [Saa Ñuu Yoo Ini](/docs/en/deploy/self-hosting) — comparar todas opciones despliegue
