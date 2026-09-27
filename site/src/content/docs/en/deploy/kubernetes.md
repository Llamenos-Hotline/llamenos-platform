---
title: "Deploy: Kubernetes (Helm)"
description: Deploy Llamenos to Kubernetes using the official Helm chart.
---

This guide covers deploying Llamenos to a Kubernetes cluster using the official Helm chart. The chart manages the application, RustFS storage, WebSocket relay WebSocket relay, and optional signal-notifier/sip-bridge services as separate deployments. You provide a PostgreSQL database.

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

Or create a `values-production.yaml` file for reproducible deploys:

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
  # Telephony (at least one required for voice):
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
  enabled: false   # set to true to enable the signal-notifier sidecar

sipBridge:
  enabled: false   # set to true to enable the SIP bridge (Asterisk/FreeSWITCH/Kamailio)
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
  --from-literal=server-WebSocket-secret=your_WebSocket_hex \
  --from-literal=RustFS-access-key=your_key \
  --from-literal=RustFS-secret-key=your_secret
```

## Prometheus monitoring

### ServiceMonitor

If you run the [Prometheus Operator](https://prometheus-operator.dev/), enable the `ServiceMonitor` in your values:

```yaml
monitoring:
  enabled: true
  serviceMonitor:
    namespace: monitoring    # namespace where Prometheus is installed
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack
```

The chart exposes `/metrics` on the app service and configures the `ServiceMonitor` to match your Prometheus selector.

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
| `app.image.repository` | Container image | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | Image tag | Chart appVersion |
| `app.image.pullPolicy` | Pull policy | `IfNotPresent` |
| `app.port` | Application port | `3000` |
| `app.replicas` | Pod replicas | `2` |
| `app.resources` | CPU/memory requests and limits | `{}` |
| `app.env` | Extra environment variables | `{}` |

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
| `secrets.serverWebSocketSecret` | Server WebSocket identity key — 64 hex chars (required) | `""` |
| `secrets.twilioAccountSid` | Twilio Account SID | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token | `""` |
| `secrets.twilioPhoneNumber` | Twilio phone number (E.164) | `""` |
| `secrets.existingSecret` | Use an existing Kubernetes Secret | `""` |

> **Tip**: For production, use `secrets.existingSecret` with External Secrets Operator, Sealed Secrets, or Vault.

### RustFS

| Parameter | Description | Default |
|-----------|-------------|---------|
| `RustFS.enabled` | Deploy RustFS | `true` |
| `RustFS.image.repository` | RustFS image | `RustFS/RustFS` |
| `RustFS.image.tag` | RustFS tag | `latest` |
| `RustFS.persistence.size` | Data volume size | `50Gi` |
| `RustFS.persistence.storageClass` | Storage class | `""` |
| `RustFS.credentials.accessKey` | RustFS root user (required) | `""` |
| `RustFS.credentials.secretKey` | RustFS root password (required) | `""` |
| `RustFS.resources` | CPU/memory requests and limits | `{}` |

### WebSocket relay

| Parameter | Description | Default |
|-----------|-------------|---------|
| `WebSocket relay.enabled` | Deploy WebSocket relay | `true` |
| `WebSocket relay.image.repository` | WebSocket relay image | `dockurr/WebSocket relay` |
| `WebSocket relay.image.tag` | WebSocket relay tag | `latest` |
| `WebSocket relay.resources` | CPU/memory requests and limits | `{}` |

> WebSocket relay is a core service — real-time events (calls, notifications, hub state) require it. Keep `WebSocket relay.enabled: true`.

### signal-notifier

| Parameter | Description | Default |
|-----------|-------------|---------|
| `signalNotifier.enabled` | Deploy signal-notifier sidecar | `false` |
| `signalNotifier.image.repository` | signal-notifier image | `ghcr.io/rhonda-rodododo/llamenos-signal-notifier` |
| `signalNotifier.resources` | CPU/memory requests and limits | `{}` |

### SIP bridge

| Parameter | Description | Default |
|-----------|-------------|---------|
| `sipBridge.enabled` | Deploy sip-bridge | `false` |
| `sipBridge.pbxType` | Backend: `asterisk`, `freeswitch`, or `kamailio` | `asterisk` |
| `sipBridge.resources` | CPU/memory requests and limits | `{}` |

### Monitoring

| Parameter | Description | Default |
|-----------|-------------|---------|
| `monitoring.enabled` | Create ServiceMonitor | `false` |
| `monitoring.serviceMonitor.interval` | Scrape interval | `30s` |
| `monitoring.serviceMonitor.scrapeTimeout` | Scrape timeout | `10s` |
| `monitoring.serviceMonitor.namespace` | Namespace for ServiceMonitor | Same as release |
| `monitoring.serviceMonitor.labels` | Additional labels for Prometheus selector | `{}` |

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

If you already have RustFS, RustFS, or another S3-compatible service, disable the built-in RustFS:

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

## Production hardening checklist

Before going live:

- [ ] **Secrets via ESO or Sealed Secrets** — never commit secrets to values files
- [ ] **Resource requests and limits** set on all deployments
- [ ] **PodDisruptionBudget** configured (`minAvailable: 1`) for zero-downtime drains
- [ ] **NetworkPolicy** restricting ingress to app pod from ingress controller only
- [ ] **Read-only root filesystem** on app container (`securityContext.readOnlyRootFilesystem: true`)
- [ ] **Non-root user** in container (`securityContext.runAsNonRoot: true`)
- [ ] **PostgreSQL TLS** enabled (set `postgres.sslMode: require` in values)
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

The deployment uses `RollingUpdate` strategy for zero-downtime upgrades. Scale replicas based on your traffic:

```bash
kubectl scale deployment llamenos --replicas=3
```

Or set `app.replicas` in your values file. PostgreSQL advisory locks ensure data consistency across replicas.

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
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

Common causes: missing secrets (`hmacSecret`, `serverWebSocketSecret`), PostgreSQL unreachable, RustFS not ready.

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
