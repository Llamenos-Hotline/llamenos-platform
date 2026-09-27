---
title: "Depoze: Kubernetes (Helm)"
description: Depoze Llamenos nan Kubernetes lè l sèvi ak chèt Helm ofisyèl la.
---

Gid sa a kouvri depoze Llamenos nan yon klastè Kubernetes lè l sèvi ak chèt Helm ofisyèl la. Chèt la jere aplikasyon an ak sèvis RustFS/Whisper opsyonèl kòm depoze separe. Ou mete yon baz done PostgreSQL.

## Prérequi

- Yon klastè Kubernetes (v1.24+) — jere (EKS, GKE, AKS) oswa otojere
- Yon instans PostgreSQL 14+ (RDS/Cloud SQL jere rekòmande, oswa otojere)
- [Helm](https://helm.sh/) v3.10+
- [kubectl](https://kubernetes.io/docs/tasks/tools/) konfigire pou klastè ou a
- Yon kontwolè ingress (NGINX Ingress, Traefik, elatriye)
- cert-manager (opsyonèl, pou sètifika TLS otomatik)
- [Bun](https://bun.sh/) enstale lokalman (pou jenere pè kle admin)


## 2. Enstale chèt la

```bash
helm install llamenos deploy/helm/llamenos/ \
  --set secrets.postgresPassword=YOUR_PG_PASSWORD \
  --set secrets.hmacSecret=YOUR_HMAC_HEX \
  --set secrets.serverWebSocketSecret=YOUR_NOSTR_HEX \
  --set postgres.host=YOUR_PG_HOST \
  --set rustfs.credentials.accessKey=your-access-key \
  --set rustfs.credentials.secretKey=your-secret-key \
  --set ingress.hosts[0].host=hotline.yourdomain.com \
  --set ingress.tls[0].secretName=llamenos-tls \
  --set ingress.tls[0].hosts[0]=hotline.yourdomain.com
```

Oswa kreye yon fichye `values-production.yaml` pou depoze repwodiksib:

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
  # twilioAccountSid: ""
  # twilioAuthToken: ""
  # twilioPhoneNumber: ""

rustfs:
  enabled: true
  persistence:
    size: 50Gi
    storageClass: "gp3"
  credentials:
    accessKey: "your-access-key"
    secretKey: "your-secret-key-change-me"

WebSocket relay:
  enabled: true

signalNotifier:
  enabled: false

monitoring:
  enabled: true
  serviceMonitor:
    interval: 30s

ingress:
  enabled: true
  className: "nginx"
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
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

Enstalasyon epi:

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## 3. Verifye depoze a

```bash
# Tcheke pod yo ap kouri
kubectl get pods -l app.kubernetes.io/instance=llamenos

# Tcheke sante aplikasyon an
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# → {"status":"ok"}
```

## 4. Konfigire DNS

Pwen domèn ou a nan IP ekstèn kontwolè ingress la oswa balanse chaj:

```bash
kubectl get ingress llamenos
```

## 5. Premye koneksyon ak konfigirasyon

Ouvri `https://hotline.yourdomain.com` nan navigatè ou a. Konekte ak nsec admin epi konplete asistan konfigirasyon an.

## Referans konfigirasyon chèt la

### Aplikasyon

| Paramèt | Deskripsyon | Default |
|-----------|-------------|---------|
| `app.image.repository` | Imaj konteyniè | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | Tag imaj | appVersion chèt la |
| `app.port` | Pò aplikasyon | `3000` |
| `app.replicas` | Replik pod | `2` |
| `app.resources` | Demann ak limit CPU/memwa | `{}` |
| `app.env` | Varyab anviwònman ekstra | `{}` |

### PostgreSQL

| Paramèt | Deskripsyon | Default |
|-----------|-------------|---------|
| `postgres.host` | Non òdinatè PostgreSQL (obligatwa) | `""` |
| `postgres.port` | Pò PostgreSQL | `5432` |
| `postgres.database` | Non baz done | `llamenos` |
| `postgres.user` | Itilizatè baz done | `llamenos` |
| `postgres.poolSize` | Gwosè pool koneksyon | `10` |

### Sekrè

| Paramèt | Deskripsyon | Default |
|-----------|-------------|---------|
| `secrets.hmacSecret` | HMAC signing key — 64 hex chars (required) | `""` |
| `secrets.serverWebSocketSecret` | Server WebSocket identity key — 64 hex chars (required) | `""` |
| `secrets.postgresPassword` | Modpas PostgreSQL (obligatwa) | `""` |
| `secrets.twilioAccountSid` | SID Kont Twilio | `""` |
| `secrets.twilioAuthToken` | Token Otantifikasyon Twilio | `""` |
| `secrets.twilioPhoneNumber` | Nimewo telefòn Twilio (E.164) | `""` |
| `secrets.existingSecret` | Itilize yon Sekrè K8s egzistan | `""` |

> **Konsèy**: Pou pwodiksyon, itilize `secrets.existingSecret` pou refere yon Sekrè jere pa External Secrets Operator, Sealed Secrets, oswa Vault.

### RustFS

| Paramèt | Deskripsyon | Default |
|-----------|-------------|---------|
| `rustfs.enabled` | Depoze RustFS | `true` |
| `rustfs.image.repository` | Imaj RustFS | `rustfs/rustfs` |
| `rustfs.image.tag` | Tag RustFS | `RELEASE.2025-01-20T14-49-07Z` |
| `rustfs.persistence.size` | Volim done RustFS | `50Gi` |
| `rustfs.persistence.storageClass` | Klas depo | `""` |
| `rustfs.credentials.accessKey` | Itilizatè rasin RustFS | `""` (obligatwa) |
| `rustfs.credentials.secretKey` | Modpas rasin RustFS | `""` (obligatwa) |
| `rustfs.resources` | Demann ak limit CPU/memwa | `{}` |

### Trankskripsyon Whisper

| Paramèt | Deskripsyon | Default |
|-----------|-------------|---------|
| `whisper.enabled` | Depoze Whisper | `false` |
| `whisper.image.repository` | Imaj Whisper | `fedirz/faster-whisper-server` |
| `whisper.image.tag` | Tag Whisper | `0.4.1` |
| `whisper.model` | Non modèl Whisper | `Systran/faster-whisper-base` |
| `whisper.device` | Aparèy: `cpu` oswa `cuda` | `cpu` |
| `whisper.resources` | Demann ak limit CPU/memwa | `{}` |

### Ingress

| Paramèt | Deskripsyon | Default |
|-----------|-------------|---------|
| `ingress.enabled` | Kreye resous Ingress | `true` |
| `ingress.className` | Klas Ingress | `nginx` |
| `ingress.annotations` | Anotasyon Ingress | `{}` |
| `ingress.hosts` | Règ òdinatè | Gade values.yaml |
| `ingress.tls` | Konfigirasyon TLS | `[]` |

### Kont sèvis

| Paramèt | Deskripsyon | Default |
|-----------|-------------|---------|
| `serviceAccount.create` | Kreye yon ServiceAccount | `true` |
| `serviceAccount.annotations` | Anotasyon SA (egzanp, IRSA) | `{}` |
| `serviceAccount.name` | Pase non SA | `""` |

## Itilize sekrè ekstèn

Pou pwodiksyon, evite mete sekrè dirèkteman nan valè Helm. Olye a, kreye Sekrè a separeman epi refere li:

```yaml
# values-production.yaml
secrets:
  existingSecret: llamenos-secrets
```

Kreye Sekrè a ak zouti ou prefere a:

```bash
# Manyèl
kubectl create secret generic llamenos-secrets \
  --from-literal=hmac-secret=your_hmac_hex \
  --from-literal=server-WebSocket-secret=your_WebSocket_hex \
  --from-literal=postgres-password=your_password \
  --from-literal=rustfs-access-key=your_key \
  --from-literal=rustfs-secret-key=your_key

# Oswa ak External Secrets Operator, Sealed Secrets, Vault, elatriye
```

## Itilize RustFS oswa S3 ekstèn

Si ou deja gen RustFS oswa yon sèvis ki konpatib ak S3, deaktive RustFS entegre a epi pase pwen final la:

```yaml
rustfs:
  enabled: false

app:
  env:
    STORAGE_ENDPOINT: "https://your-rustfs.example.com"
    STORAGE_ACCESS_KEY: "your-key"
    STORAGE_SECRET_KEY: "your-secret"
    STORAGE_BUCKET: "llamenos"
```

## Trankskripsyon GPU

Pou trankskripsyon Whisper akseleré GPU sou GPU NVIDIA:

```yaml
whisper:
  enabled: true
  device: "cuda"
  model: "Systran/faster-whisper-large-v3"
  resources:
    limits:
      nvidia.com/gpu: 1
```

Asire [plugen aparèy NVIDIA](https://github.com/NVIDIA/k8s-device-plugin) enstale nan klastè ou a.

## Eskalad

Depoze a itilize estrateji `RollingUpdate` pou mizajou san arèt. Eskalad replik yo baze sou trafik ou a:

```bash
kubectl scale deployment llamenos --replicas=3
```

Oswa mete `app.replicas` nan fichye valè ou a. Vèrou konseye PostgreSQL asire konsistans done nan tout replik yo.


## Siveyans

### Verifikasyon sante

Chèt la konfigire sond vivans, pret, ak demaraj kont `/api/health`:

```yaml
# Entegre nan modèl depoze a
livenessProbe:
  httpGet:
    path: /health/live
    port: http
  initialDelaySeconds: 15
  periodSeconds: 15
readinessProbe:
  httpGet:
    path: /health/live
    port: http
  initialDelaySeconds: 10
  periodSeconds: 10
startupProbe:
  httpGet:
    path: /health/live
    port: http
  failureThreshold: 30
  periodSeconds: 5
```

### Jounal

```bash
kubectl logs -l app.kubernetes.io/instance=llamenos -c app -f
```

## Mizajou

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

Estrateji `RollingUpdate` la bay mizajou san arèt.

## Dezenstale

```bash
helm uninstall llamenos
```

> **Remak**: PersistentVolumeClaims pa efase pa `helm uninstall`. Efase yo manyèlman si ou vle retire tout done:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## Depannaj

### Pod bloke nan CrashLoopBackOff

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

Kòz komen: sekrè ki manke, ADMIN_PUBKEY enkòrèk, PostgreSQL pa ateyab, RustFS pa pare.

### Erè koneksyon baz done

Verifye PostgreSQL ateyab soti nan klastè a:

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Ingress pa fonksyone

Verifye kontwolè ingress la ap kouri epi resous Ingress la gen yon adrès:

```bash
kubectl get ingress llamenos
kubectl describe ingress llamenos
```


## cert-manager integration

If you have [cert-manager](https://cert-manager.io/) installed, configure the cluster issuer for automatic TLS:

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

Reference it in your ingress annotations:

```yaml
ingress:
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
```

## External Secrets Operator

For production, use [External Secrets Operator](https://external-secrets.io/) to sync secrets from AWS SSM, Vault, GCP Secret Manager, etc.

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
    name: my-secret-store
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

Then reference in Helm values:

```yaml
secrets:
  existingSecret: llamenos-secrets
```

## Prometheus ServiceMonitor

Enable the `ServiceMonitor` for Prometheus Operator:

```yaml
monitoring:
  enabled: true
  serviceMonitor:
    namespace: monitoring
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack
```

## Production hardening checklist

Before going live:

- [ ] **Secrets via ESO or Sealed Secrets** — never commit secrets to values files
- [ ] **Resource requests and limits** set on all deployments
- [ ] **PodDisruptionBudget** configured (`minAvailable: 1`) for zero-downtime drains
- [ ] **NetworkPolicy** restricting ingress to app pod from ingress controller only
- [ ] **Read-only root filesystem** (`securityContext.readOnlyRootFilesystem: true`)
- [ ] **Non-root user** (`securityContext.runAsNonRoot: true`)
- [ ] **PostgreSQL TLS** enabled (`postgres.sslMode: require`)
- [ ] **cert-manager ClusterIssuer** configured for automatic Let's Encrypt renewal
- [ ] **Prometheus ServiceMonitor** enabled and scraping
- [ ] **Liveness/readiness probes** verified after deploy
- [ ] **Image pull policy** set to `IfNotPresent`
- [ ] **Ingress rate limiting** annotations configured


## Etap pwochen yo

- [Gid Admin](/docs/admin-guide) — konfigire liy chod la
- [Apèsi Otojere](/docs/deploy/self-hosting) — konpare opsyon depoze yo
- [Depoze Docker Compose](/docs/deploy/docker) — altènatif pi senp
