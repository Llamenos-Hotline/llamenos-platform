---
title: "Deploy: Kubernetes (Helm)"
description: Deploy Llamenos to Kubernetes using the official Helm chart.
---

This guide covers deploying Llamenos to a Kubernetes cluster using the official Helm chart. The chart manages the application, RustFS storage, and an optional Whisper transcription service as separate deployments. You provide a PostgreSQL database.

> **Single replica only.** Llamenos's call routing, ringing state, and WebSocket/relay sessions are process-local — there is no shared pub/sub or sticky routing across pods yet. The chart refuses to render with `app.replicas` set to anything other than `1`, and ships no autoscaling. Do not try to scale the app deployment horizontally; see [Scaling](#scaling) below.

## Prerequisites

- A Kubernetes cluster (v1.24+) — managed (EKS, GKE, AKS) or self-hosted
- A PostgreSQL 14+ instance (managed RDS/Cloud SQL recommended, or self-hosted)
- [Helm](https://helm.sh/) v3.10+
- [kubectl](https://kubernetes.io/docs/tasks/tools/) configured for your cluster
- An ingress controller (NGINX Ingress, Traefik, etc.)
- cert-manager (optional, for automatic TLS certificates)

## 1. Install the chart

```bash
helm install llamenos deploy/helm/llamenos/ \
  --set app.image.repository=YOUR_REGISTRY/llamenos \
  --set app.env.WEBHOOK_BASE_URL=https://hotline.yourdomain.com \
  --set secrets.postgresPassword=YOUR_PG_PASSWORD \
  --set secrets.hmacSecret=YOUR_HMAC_HEX \
  --set secrets.serverSecret=YOUR_SERVER_SECRET_HEX \
  --set postgres.host=YOUR_PG_HOST \
  --set rustfs.credentials.accessKey=your-access-key \
  --set rustfs.credentials.secretKey=your-secret-key \
  --set ingress.hosts[0].host=hotline.yourdomain.com \
  --set ingress.tls[0].secretName=llamenos-tls \
  --set ingress.tls[0].hosts[0]=hotline.yourdomain.com
```

`app.image.repository` has no default — the chart refuses to render without it. Point it at
wherever your own build of [`deploy/docker/Dockerfile`](https://github.com/Llamenos-Hotline/llamenos-platform/blob/main/deploy/docker/Dockerfile)
actually publishes to; the project's own CI (`.github/workflows/docker.yml`) publishes to
Docker Hub, not GHCR.

Or create a `values-production.yaml` file for reproducible deploys:

```yaml
# values-production.yaml
app:
  image:
    repository: YOUR_REGISTRY/llamenos   # required — no default, see above
    tag: "1.0.0"
    pullPolicy: IfNotPresent
  replicas: 1   # the only supported value — see the single-replica note above
  resources:
    requests:
      cpu: "500m"
      memory: "512Mi"
    limits:
      cpu: "2"
      memory: "1Gi"
  env:
    HOTLINE_NAME: "Your Hotline"
    ENVIRONMENT: "production"
    WEBHOOK_BASE_URL: "https://hotline.yourdomain.com"

postgres:
  host: my-rds-instance.region.rds.amazonaws.com
  port: 5432
  database: llamenos
  user: llamenos
  poolSize: 10

secrets:
  postgresPassword: "your-strong-password"
  hmacSecret: "64-hex-chars-hmac-signing-key"
  serverSecret: "64-hex-chars-server-secret"
  # Telephony (at least one required for voice):
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
  resources:
    requests:
      cpu: "100m"
      memory: "256Mi"
    limits:
      cpu: "500m"
      memory: "512Mi"

# asterisk, sipBridge, ntfy, and signal are declared in values.yaml but have
# no backing Deployment in this chart yet — enabling them creates a Secret
# and nothing else. Leave them disabled until that lands.
sipBridge:
  enabled: false

metrics:
  enabled: true   # creates a ServiceMonitor; requires the Prometheus Operator CRDs

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

Then install:

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## 2. Verify the deployment

```bash
# Check pods are running
kubectl get pods -l app.kubernetes.io/instance=llamenos

# Check the app health
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# -> {"status":"ok"}
```

## 3. Configure DNS

Point your domain to the ingress controller's external IP or load balancer:

```bash
kubectl get ingress llamenos
```

## 4. Initial setup

Open `https://hotline.yourdomain.com` in your browser and follow the setup wizard:

1. **Create your admin account** — set a display name and your PIN
2. **Name your hotline** — set the display name shown in the app
3. **Choose channels** — enable Voice, SMS, WhatsApp, Signal, and/or Reports
4. **Configure providers** — enter credentials for each enabled channel
5. **Review and finish**

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

Apply it, then reference it in your ingress annotations (already included in the `values-production.yaml` above):

```yaml
ingress:
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
```

cert-manager will automatically provision and renew TLS certificates via Let's Encrypt.

## External Secrets Operator

For production, avoid putting secrets directly in Helm values. Use [External Secrets Operator](https://external-secrets.io/) to sync secrets from your secret store (AWS SSM, Vault, GCP Secret Manager, etc.).

### 1. Create an ExternalSecret

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
    name: my-secret-store   # your ClusterSecretStore or SecretStore
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
    - secretKey: server-secret
      remoteRef:
        key: llamenos/server-secret
    - secretKey: rustfs-access-key
      remoteRef:
        key: llamenos/rustfs-access-key
    - secretKey: rustfs-secret-key
      remoteRef:
        key: llamenos/rustfs-secret-key
```

### 2. Reference in Helm values

```yaml
secrets:
  existingSecret: llamenos-secrets
```

Alternatively, create the secret manually and reference it the same way:

```bash
kubectl create secret generic llamenos-secrets \
  --from-literal=postgres-password=your_password \
  --from-literal=hmac-secret=your_hmac_hex \
  --from-literal=server-secret=your_server_secret_hex \
  --from-literal=rustfs-access-key=your_key \
  --from-literal=rustfs-secret-key=your_secret
```

## Prometheus monitoring

### ServiceMonitor

If you run the [Prometheus Operator](https://prometheus-operator.dev/), enable the `ServiceMonitor` in your values:

```yaml
metrics:
  enabled: true
  path: /api/metrics/prometheus
  interval: 30s
  # Name of an existing Secret with a "metrics-scrape-token" key, matching the
  # app's METRICS_SCRAPE_TOKEN. Leave unset to require authenticated admin
  # access instead of a bearer token.
  scrapeTokenSecret: ""

monitoring:
  serviceMonitor:
    scrapeTimeout: 10s
    additionalLabels:
      release: kube-prometheus-stack
```

The chart exposes `metrics.path` on the app service and configures the `ServiceMonitor` to match your Prometheus selector. `monitoring.serviceMonitor.enabled` is deprecated — `metrics.enabled` is what actually gates the resource.

### Health probes

The chart configures liveness, readiness, and startup probes against `/health/live` and `/health/ready`:

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

## Chart configuration reference

### Application

| Parameter | Description | Default |
|-----------|-------------|---------|
| `app.image.repository` | Container image (required — no default) | `""` |
| `app.image.tag` | Image tag | Chart appVersion |
| `app.image.pullPolicy` | Pull policy | `IfNotPresent` |
| `app.port` | Application port | `3000` |
| `app.replicas` | Pod replicas — the chart refuses any value other than `1` | `1` |
| `app.resources` | CPU/memory requests and limits | `{}` |
| `app.env` | Extra environment variables (`WEBHOOK_BASE_URL` required when `ENVIRONMENT` is `production`) | `{}` |

### PostgreSQL

| Parameter | Description | Default |
|-----------|-------------|---------|
| `postgres.host` | PostgreSQL hostname (required) | `""` |
| `postgres.port` | PostgreSQL port | `5432` |
| `postgres.database` | Database name | `llamenos` |
| `postgres.user` | Database user | `llamenos` |
| `postgres.poolSize` | Connection pool size | `10` |

### Secrets

| Parameter | Description | Default |
|-----------|-------------|---------|
| `secrets.postgresPassword` | PostgreSQL password (required) | `""` |
| `secrets.hmacSecret` | HMAC signing key — 64 hex chars (required) | `""` |
| `secrets.serverSecret` | Server secret — 64 hex chars (required) | `""` |
| `secrets.adminPubkey` | Admin Ed25519 identity key | `""` |
| `secrets.adminDecryptionPubkey` | Admin X25519 HPKE recipient key (required whenever `adminPubkey` is set) | `""` |
| `secrets.twilioAccountSid` | Twilio Account SID | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token | `""` |
| `secrets.twilioPhoneNumber` | Twilio phone number (E.164) | `""` |
| `secrets.existingSecret` | Use an existing Kubernetes Secret | `""` |

> **Tip**: For production, use `secrets.existingSecret` with External Secrets Operator, Sealed Secrets, or Vault.

### RustFS (blob storage)

| Parameter | Description | Default |
|-----------|-------------|---------|
| `rustfs.enabled` | Deploy RustFS | `true` |
| `rustfs.image.repository` | RustFS image | `rustfs/rustfs` |
| `rustfs.image.tag` | RustFS tag | `latest` |
| `rustfs.persistence.size` | Data volume size | `50Gi` |
| `rustfs.persistence.storageClass` | Storage class | `""` |
| `rustfs.credentials.accessKey` | RustFS root user (required) | `""` |
| `rustfs.credentials.secretKey` | RustFS root password (required) | `""` |
| `rustfs.resources` | CPU/memory requests and limits | `{}` |

### Whisper transcription (optional)

| Parameter | Description | Default |
|-----------|-------------|---------|
| `whisper.enabled` | Deploy the Whisper transcription service | `false` |
| `whisper.image.repository` / `.tag` | Whisper server image | `fedirz/faster-whisper-server` |
| `whisper.model` | Whisper model name | `Systran/faster-whisper-base` |
| `whisper.device` | `cpu` or `cuda` | `cpu` |

### Not yet wired: asterisk, sipBridge, ntfy, signal

`values.yaml` declares `asterisk`, `sipBridge`, `ntfy`, and `signal` sections (PBX, SIP
bridge, UnifiedPush relay, and Signal CLI bridge respectively), and enabling `sipBridge`
does create a `bridge-secret` entry in the chart's Secret. **None of them has a
Deployment/StatefulSet template yet** — enabling any of these deploys no workload at all.
Leave them disabled until that support lands.

### Monitoring

| Parameter | Description | Default |
|-----------|-------------|---------|
| `metrics.enabled` | Create a Prometheus Operator `ServiceMonitor` | `false` |
| `metrics.interval` | Scrape interval | `30s` |
| `metrics.path` | Metrics path scraped on the app service | `/api/metrics/prometheus` |
| `metrics.scrapeTokenSecret` | Existing Secret name holding a `metrics-scrape-token` key | `""` |
| `monitoring.serviceMonitor.scrapeTimeout` | Scrape timeout | `10s` |
| `monitoring.serviceMonitor.additionalLabels` | Additional labels for the Prometheus selector | `{}` |

### Ingress

| Parameter | Description | Default |
|-----------|-------------|---------|
| `ingress.enabled` | Create Ingress resource | `true` |
| `ingress.className` | Ingress class | `nginx` |
| `ingress.annotations` | Ingress annotations | `{}` |
| `ingress.hosts` | Host rules | See values.yaml |
| `ingress.tls` | TLS configuration | `[]` |

### Service account

| Parameter | Description | Default |
|-----------|-------------|---------|
| `serviceAccount.create` | Create a ServiceAccount | `true` |
| `serviceAccount.annotations` | SA annotations (e.g., IRSA for AWS) | `{}` |
| `serviceAccount.name` | Override SA name | `""` |

## Using an external S3-compatible store

If you already have a MinIO, RustFS, or another S3-compatible service, disable the built-in RustFS:

```yaml
rustfs:
  enabled: false

app:
  env:
    STORAGE_ENDPOINT: "https://your-storage.example.com"
    STORAGE_ACCESS_KEY: "your-key"
    STORAGE_SECRET_KEY: "your-secret"
    STORAGE_BUCKET: "llamenos"
```

## Production hardening checklist

Before going live:

- [ ] **Secrets via ESO or Sealed Secrets** — never commit secrets to values files
- [ ] **Resource requests and limits** set on all deployments
- [ ] **NetworkPolicy** restricting ingress to app pod from ingress controller only
- [ ] **Read-only root filesystem** on app container (`securityContext.readOnlyRootFilesystem: true`)
- [ ] **Non-root user** in container (`securityContext.runAsNonRoot: true`)
- [ ] **PostgreSQL TLS** enabled at the database (this chart has no `postgres.sslMode` toggle — append `?sslmode=require` via your managed database's connection settings, or front it with `stunnel`/a VPC-internal TLS proxy)
- [ ] **RustFS TLS** or mTLS between app and RustFS
- [ ] **cert-manager ClusterIssuer** configured for automatic Let's Encrypt renewal
- [ ] **Prometheus ServiceMonitor** enabled and scraping
- [ ] **Liveness/readiness probes** verified after deploy
- [ ] **RBAC** — ServiceAccount with minimal permissions
- [ ] **Image pull policy** set to `IfNotPresent` (not `Always`) for predictable deploys
- [ ] **Ingress rate limiting** annotations set to mitigate abuse

Example NetworkPolicy:

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

## Scaling

**Do not scale the app deployment horizontally.** Llamenos's call routing, ringing state,
and WebSocket/relay sessions are process-local, with no shared pub/sub or sticky routing
across pods — a second replica silently drops calls rung on one pod and misses events
published by another. The chart ships no `HorizontalPodAutoscaler`, and any `helm
install`/`helm upgrade` that sets `app.replicas` to anything other than `1` fails fast with
an explicit error instead of rendering:

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml --set app.replicas=3
# Error: execution error at (llamenos/templates/deployment-app.yaml:...): app.replicas is 3, ...
```

That guard only covers Helm itself — `kubectl scale deployment llamenos --replicas=3` talks
to the Deployment directly and bypasses it, so it will appear to succeed. Don't run it; the
app will start handling calls incorrectly with no crash or error to signal it.

Scale vertically (`app.resources`) instead, or deploy a second independent hotline instance
with its own database if you need to serve multiple, unrelated teams.

## Upgrading

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

The `RollingUpdate` strategy provides zero-downtime upgrades.

## Uninstalling

```bash
helm uninstall llamenos
```

> **Note**: PersistentVolumeClaims are not deleted by `helm uninstall`. Delete them manually if you want to remove all data:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## Troubleshooting

### Pod stuck in CrashLoopBackOff

```bash
kubectl logs -l app.kubernetes.io/instance=llamenos -c app --previous
kubectl describe pod -l app.kubernetes.io/instance=llamenos
```

Common causes: missing secrets (`hmacSecret`, `serverSecret`), missing `app.env.WEBHOOK_BASE_URL`, PostgreSQL unreachable, RustFS not ready.

### Database connection errors

Verify PostgreSQL is reachable from the cluster:

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- \
  psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Ingress not working

Verify the ingress controller is running and the Ingress resource has an address:

```bash
kubectl get ingress llamenos
kubectl describe ingress llamenos
```

### Certificate not issued

Check cert-manager certificate status:

```bash
kubectl get certificate llamenos-tls
kubectl describe certificate llamenos-tls
kubectl get certificaterequest
kubectl describe certificaterequest
```

Common causes: DNS not yet propagated, ports 80/443 not open, ClusterIssuer misconfigured.

## Next steps

- [Docker Compose Deployment](/docs/en/deploy/docker) — simpler single-server alternative
- [Self-Hosting Overview](/docs/en/deploy/self-hosting) — compare deployment options
- [Telephony Providers](/docs/en/deploy/providers/) — configure voice providers
