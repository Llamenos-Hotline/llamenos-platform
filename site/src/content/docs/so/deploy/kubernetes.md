---
title: "Deploy: Kubernetes (Helm)"
description: Deploy Llamenos to Kubernetes using the official Helm chart.
---

Tilmaahan wuxuu ku saabsan yahay sida loo dejiyo Llamenos to a Kubernetes cluster iyadoo la isticmaalayo official Helm chart. Chart-ka waxa uu maamulaa application-ka, RustFS storage, WebSocket relay, iyo adeegyada ikhtiyaarka ah ee signal-notifier/sip-bridge as separate deployments. Waxaad bixisaa PostgreSQL database.

## Shuruudaha hore

- Kubernetes cluster (v1.24+) — managed (EKS, GKE, AKS) ama self-hosted
- PostgreSQL 14+ instance (managed RDS/Cloud SQL recommended, ama self-hosted)
- [Helm](https://helm.sh/) v3.10+
- [kubectl](https://kubernetes.io/docs/tasks/tools/) configured for your cluster
- Ingress controller (NGINX Ingress, Traefik, etc.)
- cert-manager (ikhtiyaar, for automatic TLS certificates)

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

Ama samee `values-production.yaml` file si aad u hesho reproducible deploys:

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

Kadib install:

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

U jeedi domain-kaaga external IP-ga ama load balancer-ka ingress controller-ka:

```bash
kubectl get ingress llamenos
```

## 4. Initial setup

Fur `https://hotline.yourdomain.com` browser-kaaga oo raac setup wizard:

1. **Create your admin account** — set display name and PIN-kaaga
2. **Name your hotline** — set display name-ka lagu muujiyo app-ka
3. **Choose channels** — enable Voice, SMS, WhatsApp, Signal, and/or Reports
4. **Configure providers** — enter credentials for each enabled channel
5. **Review and finish**

## cert-manager integration

Haddii aad leedahay [cert-manager](https://cert-manager.io/) installed, configure cluster issuer-ka automatic TLS:

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

Apply it, kadib reference it in your ingress annotations (already included in `values-production.yaml` above):

```yaml
ingress:
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
```

cert-manager waxa uu si otomaatig ah ugu soo saariyaa oo uu cusbooneysiiyaa TLS certificates via Let's Encrypt.

## External Secrets Operator

Production-ka, ha ku qarin secrets directly in Helm values. Isticmaal [External Secrets Operator](https://external-secrets.io/) si aad u sync secrets from your secret store (AWS SSM, Vault, GCP Secret Manager, etc.).

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

Alternatively, samee secret-ka manually oo reference it the same way:

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

Haddii aad ku shaqeyneysid [Prometheus Operator](https://prometheus-operator.dev/), enable `ServiceMonitor` in your values:

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

Chart-ka waxa uu soo bandhigayaa `/metrics` on the app service oo uu configure gareeyaa `ServiceMonitor` inuu ku dhaco your Prometheus selector.

### Health probes

Chart-ka waxa uu configure gareeyaa liveness, readiness, iyo startup probes against `/health/live` and `/health/ready`:

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

| Parameter | Sharaxaad | Default |
|-----------|-------------|---------|
| `app.image.repository` | Container image | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | Image tag | Chart appVersion |
| `app.image.pullPolicy` | Pull policy | `IfNotPresent` |
| `app.port` | Application port | `3000` |
| `app.replicas` | Pod replicas | `2` |
| `app.resources` | CPU/memory requests and limits | `{}` |
| `app.env` | Extra environment variables | `{}` |

### PostgreSQL

| Parameter | Sharaxaad | Default |
|-----------|-------------|---------|
| `postgres.host` | PostgreSQL hostname (required) | `""` |
| `postgres.port` | PostgreSQL port | `5432` |
| `postgres.database` | Database name | `llamenos` |
| `postgres.user` | Database user | `llamenos` |
| `postgres.poolSize` | Connection pool size | `10` |

### Secrets

| Parameter | Sharaxaad | Default |
|-----------|-------------|---------|
| `secrets.postgresPassword` | PostgreSQL password (required) | `""` |
| `secrets.hmacSecret` | HMAC signing key — 64 hex chars (required) | `""` |
| `secrets.serverWebSocketSecret` | Server WebSocket identity key — 64 hex chars (required) | `""` |
| `secrets.twilioAccountSid` | Twilio Account SID | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token | `""` |
| `secrets.twilioPhoneNumber` | Twilio phone number (E.164) | `""` |
| `secrets.existingSecret` | Use an existing Kubernetes Secret | `""` |

> **Tip**: Production-ka, isticmaal `secrets.existingSecret` with External Secrets Operator, Sealed Secrets, ama Vault.

### RustFS

| Parameter | Sharaxaad | Default |
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

| Parameter | Sharaxaad | Default |
|-----------|-------------|---------|
| `WebSocket relay.enabled` | Deploy WebSocket relay | `true` |
| `WebSocket relay.image.repository` | WebSocket relay image | `dockurr/WebSocket relay` |
| `WebSocket relay.image.tag` | WebSocket relay tag | `latest` |
| `WebSocket relay.resources` | CPU/memory requests and limits | `{}` |

> WebSocket relay waa adeeg aasaasi ah — real-time events (calls, notifications, hub state) waxay u baahan yihiin. Sii `WebSocket relay.enabled: true`.

### signal-notifier

| Parameter | Sharaxaad | Default |
|-----------|-------------|---------|
| `signalNotifier.enabled` | Deploy signal-notifier sidecar | `false` |
| `signalNotifier.image.repository` | signal-notifier image | `ghcr.io/rhonda-rodododo/llamenos-signal-notifier` |
| `signalNotifier.resources` | CPU/memory requests and limits | `{}` |

### SIP bridge

| Parameter | Sharaxaad | Default |
|-----------|-------------|---------|
| `sipBridge.enabled` | Deploy sip-bridge | `false` |
| `sipBridge.pbxType` | Backend: `asterisk`, `freeswitch`, ama `kamailio` | `asterisk` |
| `sipBridge.resources` | CPU/memory requests and limits | `{}` |

### Monitoring

| Parameter | Sharaxaad | Default |
|-----------|-------------|---------|
| `monitoring.enabled` | Create ServiceMonitor | `false` |
| `monitoring.serviceMonitor.interval` | Scrape interval | `30s` |
| `monitoring.serviceMonitor.scrapeTimeout` | Scrape timeout | `10s` |
| `monitoring.serviceMonitor.namespace` | Namespace for ServiceMonitor | Same as release |
| `monitoring.serviceMonitor.labels` | Additional labels for Prometheus selector | `{}` |

### Ingress

| Parameter | Sharaxaad | Default |
|-----------|-------------|---------|
| `ingress.enabled` | Create Ingress resource | `true` |
| `ingress.className` | Ingress class | `nginx` |
| `ingress.annotations` | Ingress annotations | `{}` |
| `ingress.hosts` | Host rules | See values.yaml |
| `ingress.tls` | TLS configuration | `[]` |

### Service account

| Parameter | Sharaxaad | Default |
|-----------|-------------|---------|
| `serviceAccount.create` | Create a ServiceAccount | `true` |
| `serviceAccount.annotations` | SA annotations (e.g., IRSA for AWS) | `{}` |
| `serviceAccount.name` | Override SA name | `""` |

## Using an external S3-compatible store

Haddii hore uu kuu jiro RustFS, RustFS, ama kale S3-compatible service, disable built-in RustFS:

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

Ka hor inta aan la bilaabin:

- [ ] **Secrets via ESO or Sealed Secrets** — never commit secrets to values files
- [ ] **Resource requests and limits** set on all deployments
- [ ] **PodDisruptionBudget** configured (`minAvailable: 1`) for zero-downtime drains
- [ ] **NetworkPolicy** restricting ingress to app pod from ingress controller only
- [ ] **Read-only root filesystem** on app container (`securityContext.readOnlyRootFilesystem: true`)
- [ ] **Non-root user** in container (`securityContext.runAsNonRoot: true`)
- [ ] **PostgreSQL TLS** enabled (set `postgres.sslMode: require` in values)
- [ ] **RustFS TLS** ama mTLS between app and RustFS
- [ ] **cert-manager ClusterIssuer** configured for automatic Let's Encrypt renewal
- [ ] **Prometheus ServiceMonitor** enabled and scraping
- [ ] **Liveness/readiness probes** verified after deploy
- [ ] **RBAC** — ServiceAccount with minimal permissions
- [ ] **Image pull policy** set to `IfNotPresent` (ma aha `Always`) for predictable deploys
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

Deployment-ka waxa uu isticmaalaa `RollingUpdate` strategy for zero-downtime upgrades. Scale replicas based on your traffic:

```bash
kubectl scale deployment llamenos --replicas=3
```

Ama set `app.replicas` in your values file. PostgreSQL advisory locks waxay hubiyaan data consistency across replicas.

## Upgrading

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

`RollingUpdate` strategy waxay bixisaa zero-downtime upgrades.

## Uninstalling

```bash
helm uninstall llamenos
```

> **Note**: PersistentVolumeClaims ma la tirtiro by `helm uninstall`. Tirtir manually haddii aad rabto inaad ka saarto dhammaan xogta:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## Troubleshooting

### Pod stuck in CrashLoopBackOff

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

Causes caadi ah: missing secrets (`hmacSecret`, `serverWebSocketSecret`), PostgreSQL unreachable, RustFS not ready.

### Database connection errors

Verify PostgreSQL is reachable from the cluster:

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- \
  psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Ingress not working

Verify ingress controller is running and Ingress resource has an address:

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

Causes caadi ah: DNS not yet propagated, ports 80/443 not open, ClusterIssuer misconfigured.

## Next steps

- [Docker Compose Deployment](/docs/en/deploy/docker) — simpler single-server alternative
- [Self-Hosting Overview](/docs/en/deploy/self-hosting) — compare deployment options
- [Telephony Providers](/docs/en/deploy/providers/) — configure voice providers
