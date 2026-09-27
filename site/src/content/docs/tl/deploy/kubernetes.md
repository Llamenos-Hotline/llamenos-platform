---
title: "Deploy: Kubernetes (Helm)"
description: I-deploy ang Llamenos sa Kubernetes gamit ang opisyal na Helm chart.
---

Saklaw ng gabay na ito ang pag-deploy ng Llamenos sa isang Kubernetes cluster gamit ang opisyal na Helm chart. Pinamamahalaan ng chart ang application at mga opsyonal na RustFS/Whisper service bilang mga hiwalay na deployment. Kailangan mong magbigay ng PostgreSQL database.

## Mga kinakailangan

- Isang Kubernetes cluster (v1.24+) — managed (EKS, GKE, AKS) o self-hosted
- Isang PostgreSQL 14+ instance (inirerekomenda ang managed RDS/Cloud SQL, o self-hosted)
- [Helm](https://helm.sh/) v3.10+
- [kubectl](https://kubernetes.io/docs/tasks/tools/) na naka-configure para sa iyong cluster
- Isang ingress controller (NGINX Ingress, Traefik, atbp.)
- cert-manager (opsyonal, para sa automatic TLS certificates)
- [Bun](https://bun.sh/) na naka-install sa lokal (para sa paggawa ng admin keypair)


## 2. I-install ang chart

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

O gumawa ng `values-production.yaml` file para sa mga reproducible deploy:

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

Pagkatapos ay i-install:

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## 3. I-verify ang deployment

```bash
# Suriin kung tumatakbo ang mga pod
kubectl get pods -l app.kubernetes.io/instance=llamenos

# Suriin ang app health
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# → {"status":"ok"}
```

## 4. I-configure ang DNS

Ituro ang iyong domain sa external IP o load balancer ng ingress controller:

```bash
kubectl get ingress llamenos
```

## 5. Unang pag-login at setup

Buksan ang `https://hotline.yourdomain.com` sa iyong browser. Mag-login gamit ang Follow the setup wizard:.

## Sanggunian sa configuration ng Chart

### Application

| Parameter | Paglalarawan | Default |
|-----------|-------------|---------|
| `app.image.repository` | Container image | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | Image tag | Chart appVersion |
| `app.port` | Application port | `3000` |
| `app.replicas` | Pod replicas | `2` |
| `app.resources` | CPU/memory requests at limits | `{}` |
| `app.env` | Karagdagang environment variables | `{}` |

### PostgreSQL

| Parameter | Paglalarawan | Default |
|-----------|-------------|---------|
| `postgres.host` | PostgreSQL hostname (kinakailangan) | `""` |
| `postgres.port` | PostgreSQL port | `5432` |
| `postgres.database` | Pangalan ng database | `llamenos` |
| `postgres.user` | Database user | `llamenos` |
| `postgres.poolSize` | Connection pool size | `10` |

### Mga Secret

| Parameter | Paglalarawan | Default |
|-----------|-------------|---------|
| `secrets.hmacSecret` | HMAC signing key — 64 hex chars (required) | `""` |
| `secrets.serverWebSocketSecret` | Server WebSocket identity key — 64 hex chars (required) | `""` |
| `secrets.postgresPassword` | PostgreSQL password (kinakailangan) | `""` |
| `secrets.twilioAccountSid` | Twilio Account SID | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token | `""` |
| `secrets.twilioPhoneNumber` | Twilio phone number (E.164) | `""` |
| `secrets.existingSecret` | Gumamit ng umiiral na K8s Secret | `""` |

> **Tip**: Para sa production, gamitin ang `secrets.existingSecret` para mag-reference ng Secret na pinamamahalaan ng External Secrets Operator, Sealed Secrets, o Vault.

### RustFS

| Parameter | Paglalarawan | Default |
|-----------|-------------|---------|
| `rustfs.enabled` | I-deploy ang RustFS | `true` |
| `rustfs.image.repository` | RustFS image | `rustfs/rustfs` |
| `rustfs.image.tag` | RustFS tag | `RELEASE.2025-01-20T14-49-07Z` |
| `rustfs.persistence.size` | RustFS data volume | `50Gi` |
| `rustfs.persistence.storageClass` | Storage class | `""` |
| `rustfs.credentials.accessKey` | RustFS root user | `""` (kinakailangan) |
| `rustfs.credentials.secretKey` | RustFS root password | `""` (kinakailangan) |
| `rustfs.resources` | CPU/memory requests at limits | `{}` |

### Whisper transcription

| Parameter | Paglalarawan | Default |
|-----------|-------------|---------|
| `whisper.enabled` | I-deploy ang Whisper | `false` |
| `whisper.image.repository` | Whisper image | `fedirz/faster-whisper-server` |
| `whisper.image.tag` | Whisper tag | `0.4.1` |
| `whisper.model` | Pangalan ng Whisper model | `Systran/faster-whisper-base` |
| `whisper.device` | Device: `cpu` o `cuda` | `cpu` |
| `whisper.resources` | CPU/memory requests at limits | `{}` |

### Ingress

| Parameter | Paglalarawan | Default |
|-----------|-------------|---------|
| `ingress.enabled` | Gumawa ng Ingress resource | `true` |
| `ingress.className` | Ingress class | `nginx` |
| `ingress.annotations` | Ingress annotations | `{}` |
| `ingress.hosts` | Host rules | Tingnan ang values.yaml |
| `ingress.tls` | TLS configuration | `[]` |

### Service account

| Parameter | Paglalarawan | Default |
|-----------|-------------|---------|
| `serviceAccount.create` | Gumawa ng ServiceAccount | `true` |
| `serviceAccount.annotations` | SA annotations (hal. IRSA) | `{}` |
| `serviceAccount.name` | I-override ang pangalan ng SA | `""` |

## Paggamit ng external secrets

Para sa production, iwasan ang paglagay ng mga secret nang direkta sa Helm values. Sa halip, gumawa ng Secret nang hiwalay at i-reference ito:

```yaml
# values-production.yaml
secrets:
  existingSecret: llamenos-secrets
```

Gumawa ng Secret gamit ang napiling tool:

```bash
# Manual
kubectl create secret generic llamenos-secrets \
  --from-literal=hmac-secret=your_hmac_hex \
  --from-literal=server-WebSocket-secret=your_WebSocket_hex \
  --from-literal=postgres-password=your_password \
  --from-literal=rustfs-access-key=your_key \
  --from-literal=rustfs-secret-key=your_key

# O gamit ang External Secrets Operator, Sealed Secrets, Vault, atbp.
```

## Paggamit ng external RustFS o S3

Kung mayroon ka nang RustFS o S3-compatible service, i-disable ang built-in RustFS at ipasa ang endpoint:

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

## GPU transcription

Para sa GPU-accelerated Whisper transcription sa NVIDIA GPUs:

```yaml
whisper:
  enabled: true
  device: "cuda"
  model: "Systran/faster-whisper-large-v3"
  resources:
    limits:
      nvidia.com/gpu: 1
```

Siguraduhing naka-install ang [NVIDIA device plugin](https://github.com/NVIDIA/k8s-device-plugin) sa iyong cluster.

## Pag-scale

Gumagamit ang deployment ng `RollingUpdate` strategy para sa zero-downtime upgrades. I-scale ang mga replica batay sa iyong traffic:

```bash
kubectl scale deployment llamenos --replicas=3
```

O itakda ang `app.replicas` sa iyong values file. Tinitiyak ng PostgreSQL advisory locks ang data consistency sa mga replica.


## Monitoring

### Health checks

Nag-co-configure ang chart ng liveness, readiness, at startup probes laban sa `/api/health`:

```yaml
# Built into the deployment template
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

### Mga log

```bash
kubectl logs -l app.kubernetes.io/instance=llamenos -c app -f
```

## Pag-upgrade

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

Nagbibigay ang `RollingUpdate` strategy ng zero-downtime upgrades.

## Pag-uninstall

```bash
helm uninstall llamenos
```

> **Paalala**: Hindi dine-delete ng `helm uninstall` ang mga PersistentVolumeClaim. I-delete ang mga ito nang mano-mano kung gusto mong alisin ang lahat ng data:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## Troubleshooting

### Pod na naka-stuck sa CrashLoopBackOff

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

Mga karaniwang sanhi: kulang na mga secret, maling ADMIN_PUBKEY, hindi maabot ang PostgreSQL, hindi pa handa ang RustFS.

### Mga error sa database connection

I-verify na maabot ang PostgreSQL mula sa cluster:

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Hindi gumagana ang Ingress

I-verify na tumatakbo ang ingress controller at may address ang Ingress resource:

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


## Mga susunod na hakbang

- [Gabay para sa Admin](/docs/admin-guide) — i-configure ang hotline
- [Pangkalahatang-tanaw ng Self-Hosting](/docs/deploy/self-hosting) — ihambing ang mga opsyon sa deployment
- [Docker Compose Deployment](/docs/deploy/docker) — mas simpleng alternatibo
