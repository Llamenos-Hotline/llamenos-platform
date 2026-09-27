---
title: "Kunu'i: Kubernetes (Helm)"
description: Ke desplegar Llámenos a Kubernetes nuu chart Helm oficial.
---

Yaa guía cubre ke desplegar Llámenos a iin clúster Kubernetes nuu chart Helm oficial. Chart gestiona aplicación, almacenamiento RustFS, relé WebSocket, ni servicios opcionales signal-notifier/sip-bridge nuu despliegues separados. Usted proporciona base datos PostgreSQL.

## Requisitos previos

- Iin clúster Kubernetes (v1.24+) — gestionado (EKS, GKE, AKS) a autoalojado
- Iin instancia PostgreSQL 14+ (RDS/Cloud SQL gestionado recomendado, a autoalojado)
- [Helm](https://helm.sh/) v3.10+
- [kubectl](https://kubernetes.io/docs/tasks/tools/) configurado nuu clúster
- Iin controlador ingress (NGINX Ingress, Traefik, etc.)
- cert-manager (opcional, nuu certificados TLS automáticos)

## 1. Instalar chart

```bash
helm install llamenos deploy/helm/llamenos/ \
  --set secrets.postgresPassword=YOUR_PG_PASSWORD \
  --set secrets.hmacSecret=YOUR_HMAC_HEX \
  --set secrets.serverWebSocketSecret=YOUR_NOSTR_HEX \
  --set postgres.host=YOUR_PG_HOST \
  --set RustFS.credentials.accessKey=your-access-key \
  --set RustFS.credentials.secretKey=your-secret-key \
  --set ingress.hosts[0].host=hotline.yourdomain.com \
  --set ingress.tls[0].secretName=llamenos-tls \
  --set ingress.tls[0].hosts[0]=hotline.yourdomain.com
```

O cree iin archivo `values-production.yaml` nuu despliegues reproducibles:

```yaml
# values-production.yaml
app:
  image:
    repository: ghcr.io/rhonda-rodododo/llamenos-platform
    tag: "1.0.0"
    pullPolicy: IfNotPresent
  replicas: 2
  resources:
    requests:
      cpu: "500m"
      memory: "512Mi"
    limits:
      cpu: "2"
      memory: "1Gi"
  env:
    HOTLINE_NAME: "Your Hotline"
    NODE_ENV: "production"

postgres:
  host: my-rds-instance.region.rds.amazonaws.com
  port: 5432
  database: llamenos
  user: llamenos
  poolSize: 10

secrets:
  postgresPassword: "your-strong-password"
  hmacSecret: "64-hex-chars-hmac-signing-key"
  serverWebSocketSecret: "64-hex-chars-WebSocket-identity-key"
  # Telephony (al menos uno requerido nuu voz):
  # twilioAccountSid: ""
  # twilioAuthToken: ""
  # twilioPhoneNumber: ""

RustFS:
  enabled: true
  persistence:
    size: 50Gi
    storageClass: "gp3"
  credentials:
    accessKey: "your-access-key"
    secretKey: "your-secret-key-change-me"
  resources:
    requests:
      cpu: "100m"
      memory: "256Mi"
    limits:
      cpu: "500m"
      memory: "512Mi"

WebSocket relay:
  enabled: true
  resources:
    requests:
      cpu: "50m"
      memory: "64Mi"
    limits:
      cpu: "200m"
      memory: "128Mi"

signalNotifier:
  enabled: false   # establecer true nuu habilitar sidecar signal-notifier

sipBridge:
  enabled: false   # establecer true nuu habilitar SIP bridge (Asterisk/FreeSWITCH/Kamailio)
  # pbxType: asterisk

monitoring:
  enabled: true
  serviceMonitor:
    interval: 30s
    scrapeTimeout: 10s

ingress:
  enabled: true
  className: "nginx"
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
  hosts:
    - host: hotline.yourdomain.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: llamenos-tls
      hosts:
        - hotline.yourdomain.com
```

Luego instale:

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## 2. Verificar despliegue

```bash
# Verificar pods están corriendo
kubectl get pods -l app.kubernetes.io/instance=llamenos

# Verificar salud aplicación
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# -> {"status":"ok"}
```

## 3. Ke configurar DNS

Apunte dominio a IP externa controlador ingress o balanceador carga:

```bash
kubectl get ingress llamenos
```

## 4. Configuración inicial

Abra `https://hotline.yourdomain.com` nuu navegador ni siga asistente configuración:

1. **Crear cuenta ña'a** — ke establecer nombre visible ni PIN
2. **Nombrar línea caliente** — ke establecer nombre visible nuu aplicación
3. **Escoger canales** — habilitar Voz, SMS, WhatsApp, Signal, y/o Reportes
4. **Configurar proveedores** — ke ingresar credenciales nuu cada canal habilitado
5. **Revisar ni ke terminar**

## Integración cert-manager

Nu tiene [cert-manager](https://cert-manager.io/) instalado, configure emisor clúster nuu TLS automático:

```yaml
# cluster-issuer.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@yourdomain.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: nginx
```

Aplíquelo, luego referéncelo nuu anotaciones ingress (ya incluido nuu `values-production.yaml` de arriba):

```yaml
ingress:
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
```

cert-manager provisionará ni renovará certificados TLS automáticamente vía Let's Encrypt.

## External Secrets Operator

Nu producción, evite poner secretos directamente nuu valores Helm. Use [External Secrets Operator](https://external-secrets.io/) nuu sincronizar secretos nuu almacén secretos (AWS SSM, Vault, GCP Secret Manager, etc.).

### 1. Crear Iin ExternalSecret

```yaml
# llamenos-externalsecret.yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: llamenos-secrets
  namespace: llamenos
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: my-secret-store   # ClusterSecretStore o SecretStore
    kind: ClusterSecretStore
  target:
    name: llamenos-secrets
    creationPolicy: Owner
  data:
    - secretKey: postgres-password
      remoteRef:
        key: llamenos/postgres-password
    - secretKey: hmac-secret
      remoteRef:
        key: llamenos/hmac-secret
    - secretKey: server-WebSocket-secret
      remoteRef:
        key: llamenos/server-WebSocket-secret
    - secretKey: RustFS-access-key
      remoteRef:
        key: llamenos/RustFS-access-key
    - secretKey: RustFS-secret-key
      remoteRef:
        key: llamenos/RustFS-secret-key
```

### 2. Referenciar nuu valores Helm

```yaml
secrets:
  existingSecret: llamenos-secrets
```

Alternativamente, cree secreto manualmente ni referéncielo mismo modo:

```bash
kubectl create secret generic llamenos-secrets \
  --from-literal=postgres-password=your_password \
  --from-literal=hmac-secret=your_hmac_hex \
  --from-literal=server-WebSocket-secret=your_WebSocket_hex \
  --from-literal=RustFS-access-key=your_key \
  --from-literal=RustFS-secret-key=your_secret
```

## Monitoreo Prometheus

### ServiceMonitor

Nu corre [Prometheus Operator](https://prometheus-operator.dev/), habilite `ServiceMonitor` nuu valores:

```yaml
monitoring:
  enabled: true
  serviceMonitor:
    namespace: monitoring    # namespace donde Prometheus está instalado
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack
```

Chart expone `/metrics` nuu servicio aplicación ni configura `ServiceMonitor` nuu coincidir nuu selector Prometheus.

### Sondas salud

Chart configura sondas vida, preparación, ni inicio contra `/health/live` ni `/health/ready`:

```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: http
  initialDelaySeconds: 15
  periodSeconds: 15
readinessProbe:
  httpGet:
    path: /health/ready
    port: http
  initialDelaySeconds: 10
  periodSeconds: 10
startupProbe:
  httpGet:
    path: /health/ready
    port: http
  failureThreshold: 30
  periodSeconds: 5
```

### Logs

```bash
kubectl logs -l app.kubernetes.io/instance=llamenos -c app -f
```

## Referencia configuración chart

### Aplicación

| Parámetro | Descripción | Predeterminado |
|-----------|-------------|---------|
| `app.image.repository` | Imagen contenedor | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | Etiqueta imagen | Chart appVersion |
| `app.image.pullPolicy` | Política extracción | `IfNotPresent` |
| `app.port` | Puerto aplicación | `3000` |
| `app.replicas` | Réplicas pod | `2` |
| `app.resources` | Solicitudes/límites CPU/memoria | `{}` |
| `app.env` | Variables entorno extra | `{}` |

### PostgreSQL

| Parámetro | Descripción | Predeterminado |
|-----------|-------------|---------|
| `postgres.host` | Hostname PostgreSQL (requerido) | `""` |
| `postgres.port` | Puerto PostgreSQL | `5432` |
| `postgres.database` | Nombre base datos | `llamenos` |
| `postgres.user` | Usuario base datos | `llamenos` |
| `postgres.poolSize` | Tamaño pool conexiones | `10` |

### Secretos

| Parámetro | Descripción | Predeterminado |
|-----------|-------------|---------|
| `secrets.postgresPassword` | Contraseña PostgreSQL (requerido) | `""` |
| `secrets.hmacSecret` | Llave firma HMAC — 64 hex (requerido) | `""` |
| `secrets.serverWebSocketSecret` | Llave identidad servidor WebSocket — 64 hex (requerido) | `""` |
| `secrets.twilioAccountSid` | Twilio Account SID | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token | `""` |
| `secrets.twilioPhoneNumber` | Número Twilio (E.164) | `""` |
| `secrets.existingSecret` | Usar iin Kubernetes Secret existente | `""` |

> **Consejo**: Nu producción, use `secrets.existingSecret` nuu External Secrets Operator, Sealed Secrets, a Vault.

### RustFS

| Parámetro | Descripción | Predeterminado |
|-----------|-------------|---------|
| `RustFS.enabled` | Desplegar RustFS | `true` |
| `RustFS.image.repository` | Imagen RustFS | `RustFS/RustFS` |
| `RustFS.image.tag` | Etiqueta RustFS | `latest` |
| `RustFS.persistence.size` | Tamaño volumen datos | `50Gi` |
| `RustFS.persistence.storageClass` | Clase almacenamiento | `""` |
| `RustFS.credentials.accessKey` | Usuario raíz RustFS (requerido) | `""` |
| `RustFS.credentials.secretKey` | Contraseña raíz RustFS (requerido) | `""` |
| `RustFS.resources` | Solicitudes/límites CPU/memoria | `{}` |

### Relé WebSocket

| Parámetro | Descripción | Predeterminado |
|-----------|-------------|---------|
| `WebSocket relay.enabled` | Desplegar relé WebSocket | `true` |
| `WebSocket relay.image.repository` | Imagen relé WebSocket | `dockurr/WebSocket relay` |
| `WebSocket relay.image.tag` | Etiqueta relé WebSocket | `latest` |
| `WebSocket relay.resources` | Solicitudes/límites CPU/memoria | `{}` |

> Relé WebSocket iin servicio núcleo — eventos tiempo real (llamadas, notificaciones, estado hub) lo requieren. Mantenga `WebSocket relay.enabled: true`.

### signal-notifier

| Parámetro | Descripción | Predeterminado |
|-----------|-------------|---------|
| `signalNotifier.enabled` | Desplegar sidecar signal-notifier | `false` |
| `signalNotifier.image.repository` | Imagen signal-notifier | `ghcr.io/rhonda-rodododo/llamenos-signal-notifier` |
| `signalNotifier.resources` | Solicitudes/límites CPU/memoria | `{}` |

### SIP bridge

| Parámetro | Descripción | Predeterminado |
|-----------|-------------|---------|
| `sipBridge.enabled` | Desplegar sip-bridge | `false` |
| `sipBridge.pbxType` | Backend: `asterisk`, `freeswitch`, a `kamailio` | `asterisk` |
| `sipBridge.resources` | Solicitudes/límites CPU/memoria | `{}` |

### Monitoreo

| Parámetro | Descripción | Predeterminado |
|-----------|-------------|---------|
| `monitoring.enabled` | Crear ServiceMonitor | `false` |
| `monitoring.serviceMonitor.interval` | Intervalo recolección | `30s` |
| `monitoring.serviceMonitor.scrapeTimeout` | Tiempo espera recolección | `10s` |
| `monitoring.serviceMonitor.namespace` | Namespace ServiceMonitor | Mismo release |
| `monitoring.serviceMonitor.labels` | Etiquetas adicionales selector Prometheus | `{}` |

### Ingress

| Parámetro | Descripción | Predeterminado |
|-----------|-------------|---------|
| `ingress.enabled` | Crear recurso Ingress | `true` |
| `ingress.className` | Clase ingress | `nginx` |
| `ingress.annotations` | Anotaciones ingress | `{}` |
| `ingress.hosts` | Reglas host | Ver values.yaml |
| `ingress.tls` | Configuración TLS | `[]` |

### Cuenta servicio

| Parámetro | Descripción | Predeterminado |
|-----------|-------------|---------|
| `serviceAccount.create` | Crear ServiceAccount | `true` |
| `serviceAccount.annotations` | Anotaciones SA (ej., IRSA nuu AWS) | `{}` |
| `serviceAccount.name` | Sobreescribir nombre SA | `""` |

## Usar almacén S3-compatible externo

Nu ya tiene RustFS, RustFS, a otro servicio compatible S3, deshabilite RustFS integrado:

```yaml
RustFS:
  enabled: false

app:
  env:
    STORAGE_ENDPOINT: "https://your-storage.example.com"
    STORAGE_ACCESS_KEY: "your-key"
    STORAGE_SECRET_KEY: "your-secret"
    STORAGE_BUCKET: "llamenos"
```

## Lista verificación endurecimiento producción

Antes de ir en vivo:

- [ ] **Secretos vía ESO o Sealed Secrets** — nunca commitear secretos a archivos valores
- [ ] **Solicitudes ni límites recursos** establecidos nuu todos despliegues
- [ ] **PodDisruptionBudget** configurado (`minAvailable: 1`) nuu drenajes sin tiempo muerto
- [ ] **NetworkPolicy** restringiendo ingress a pod aplicación solo nuu controlador ingress
- [ ] **Sistema archivos solo lectura** nuu contenedor aplicación (`securityContext.readOnlyRootFilesystem: true`)
- [ ] **Usuario no root** nuu contenedor (`securityContext.runAsNonRoot: true`)
- [ ] **PostgreSQL TLS** habilitado (establecer `postgres.sslMode: require` nuu valores)
- [ ] **RustFS TLS** o mTLS entre aplicación ni RustFS
- [ ] **cert-manager ClusterIssuer** configurado nuu renovación automática Let's Encrypt
- [ ] **Prometheus ServiceMonitor** habilitado ni recolectando
- [ ] **Sondas vida/preparación** verificadas después desplegar
- [ ] **RBAC** — ServiceAccount nuu permisos mínimos
- [ ] **Política extracción imagen** establecida a `IfNotPresent` (no `Always`) nuu despliegues predecibles
- [ ] **Límite tasa ingress** anotaciones establecidas nuu mitigar abuso

Ejemplo NetworkPolicy:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: llamenos-app
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: llamenos
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      ports:
        - port: 3000
```

## Escalado

Despliegue usa estrategia `RollingUpdate` nuu actualizaciones sin tiempo muerto. Escale réplicas basado nuu tráfico:

```bash
kubectl scale deployment llamenos --replicas=3
```

O establecer `app.replicas` nuu archivo valores. Bloqueos asesoría PostgreSQL aseguran consistencia datos nuu réplicas.

## Actualizando

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

Estrategia `RollingUpdate` proporciona actualizaciones sin tiempo muerto.

## Desinstalando

```bash
helm uninstall llamenos
```

> **Nota**: PersistentVolumeClaims no se eliminan por `helm uninstall`. Elimínelos manualmente nuu quiere remover todos datos:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## Ke kunche'e problemas

### Pod atascado nuu CrashLoopBackOff

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

Causas comunes: secretos faltantes (`hmacSecret`, `serverWebSocketSecret`), PostgreSQL inalcanzable, RustFS no listo.

### Errores conexión base datos

Verifique PostgreSQL es alcanzable nuu clúster:

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- \
  psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Ingress no funciona

Verifique controlador ingress está corriendo ni recurso Ingress tiene dirección:

```bash
kubectl get ingress llamenos
kubectl describe ingress llamenos
```

### Certificado no emitido

Verifique estado certificado cert-manager:

```bash
kubectl get certificate llamenos-tls
kubectl describe certificate llamenos-tls
kubectl get certificaterequest
kubectl describe certificaterequest
```

Causas comunes: DNS aún no propagado, puertos 80/443 no abiertos, ClusterIssuer mal configurado.

## Siguientes pasos

- [Despliegue Docker Compose](/docs/en/deploy/docker) — alternativa servidor único más simple
- [Saa Ñuu Yoo Ini](/docs/en/deploy/self-hosting) — comparar opciones despliegue
- [Proveedores Telefonía](/docs/en/deploy/providers/) — configurar proveedores voz
