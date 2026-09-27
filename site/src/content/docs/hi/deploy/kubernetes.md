---
title: "Deploy: Kubernetes (Helm)"
description: आधिकारिक Helm chart का उपयोग करके Llamenos को Kubernetes पर deploy करें।
---

यह गाइड आधिकारिक Helm chart का उपयोग करके Llamenos को Kubernetes cluster पर deploy करने को कवर करती है। Chart अलग deployments के रूप में एप्लिकेशन और वैकल्पिक RustFS/Whisper services प्रबंधित करता है। आप एक PostgreSQL डेटाबेस प्रदान करते हैं।

## पूर्वापेक्षाएं

- एक Kubernetes cluster (v1.24+) — managed (EKS, GKE, AKS) या self-hosted
- एक PostgreSQL 14+ instance (managed RDS/Cloud SQL अनुशंसित, या self-hosted)
- [Helm](https://helm.sh/) v3.10+
- आपके cluster के लिए configured [kubectl](https://kubernetes.io/docs/tasks/tools/)
- एक ingress controller (NGINX Ingress, Traefik, आदि)
- cert-manager (वैकल्पिक, स्वचालित TLS certificates के लिए)
- स्थानीय रूप से इंस्टॉल [Bun](https://bun.sh/) (admin keypair जनरेट करने के लिए)


## 2. Chart इंस्टॉल करें

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

या reproducible deploys के लिए एक `values-production.yaml` फ़ाइल बनाएं:

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

फिर install करें:

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## 3. Deployment सत्यापित करें

```bash
# Check pods are running
kubectl get pods -l app.kubernetes.io/instance=llamenos

# Check the app health
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# → {"status":"ok"}
```

## 4. DNS कॉन्फ़िगर करें

अपने domain को ingress controller के external IP या load balancer पर point करें:

```bash
kubectl get ingress llamenos
```

## 5. पहला लॉगिन और setup

अपने browser में `https://hotline.yourdomain.com` खोलें। Follow the setup wizard: पूरा करें।

## Chart configuration reference

### एप्लिकेशन

| Parameter | विवरण | Default |
|-----------|-------------|---------|
| `app.image.repository` | Container image | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | Image tag | Chart appVersion |
| `app.port` | Application port | `3000` |
| `app.replicas` | Pod replicas | `2` |
| `app.resources` | CPU/memory requests और limits | `{}` |
| `app.env` | अतिरिक्त environment variables | `{}` |

### PostgreSQL

| Parameter | विवरण | Default |
|-----------|-------------|---------|
| `postgres.host` | PostgreSQL hostname (आवश्यक) | `""` |
| `postgres.port` | PostgreSQL port | `5432` |
| `postgres.database` | Database name | `llamenos` |
| `postgres.user` | Database user | `llamenos` |
| `postgres.poolSize` | Connection pool size | `10` |

### Secrets

| Parameter | विवरण | Default |
|-----------|-------------|---------|
| `secrets.hmacSecret` | HMAC signing key — 64 hex chars (required) | `""` |
| `secrets.serverWebSocketSecret` | Server WebSocket identity key — 64 hex chars (required) | `""` |
| `secrets.postgresPassword` | PostgreSQL password (आवश्यक) | `""` |
| `secrets.twilioAccountSid` | Twilio Account SID | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token | `""` |
| `secrets.twilioPhoneNumber` | Twilio phone number (E.164) | `""` |
| `secrets.existingSecret` | एक मौजूदा K8s Secret उपयोग करें | `""` |

> **Tip**: Production के लिए, External Secrets Operator, Sealed Secrets, या Vault द्वारा प्रबंधित Secret को reference करने के लिए `secrets.existingSecret` उपयोग करें।

### RustFS

| Parameter | विवरण | Default |
|-----------|-------------|---------|
| `rustfs.enabled` | RustFS deploy करें | `true` |
| `rustfs.image.repository` | RustFS image | `rustfs/rustfs` |
| `rustfs.image.tag` | RustFS tag | `RELEASE.2025-01-20T14-49-07Z` |
| `rustfs.persistence.size` | RustFS data volume | `50Gi` |
| `rustfs.persistence.storageClass` | Storage class | `""` |
| `rustfs.credentials.accessKey` | RustFS root user | `""` (आवश्यक) |
| `rustfs.credentials.secretKey` | RustFS root password | `""` (आवश्यक) |
| `rustfs.resources` | CPU/memory requests और limits | `{}` |

### Whisper transcription

| Parameter | विवरण | Default |
|-----------|-------------|---------|
| `whisper.enabled` | Whisper deploy करें | `false` |
| `whisper.image.repository` | Whisper image | `fedirz/faster-whisper-server` |
| `whisper.image.tag` | Whisper tag | `0.4.1` |
| `whisper.model` | Whisper model name | `Systran/faster-whisper-base` |
| `whisper.device` | Device: `cpu` या `cuda` | `cpu` |
| `whisper.resources` | CPU/memory requests और limits | `{}` |

### Ingress

| Parameter | विवरण | Default |
|-----------|-------------|---------|
| `ingress.enabled` | Ingress resource बनाएं | `true` |
| `ingress.className` | Ingress class | `nginx` |
| `ingress.annotations` | Ingress annotations | `{}` |
| `ingress.hosts` | Host rules | values.yaml देखें |
| `ingress.tls` | TLS configuration | `[]` |

### Service account

| Parameter | विवरण | Default |
|-----------|-------------|---------|
| `serviceAccount.create` | एक ServiceAccount बनाएं | `true` |
| `serviceAccount.annotations` | SA annotations (जैसे IRSA) | `{}` |
| `serviceAccount.name` | SA name override करें | `""` |

## External secrets उपयोग करना

Production के लिए, Helm values में सीधे secrets डालने से बचें। इसके बजाय, Secret अलग से बनाएं और reference करें:

```yaml
# values-production.yaml
secrets:
  existingSecret: llamenos-secrets
```

अपने पसंदीदा tool के साथ Secret बनाएं:

```bash
# Manual
kubectl create secret generic llamenos-secrets \
  --from-literal=hmac-secret=your_hmac_hex \
  --from-literal=server-WebSocket-secret=your_WebSocket_hex \
  --from-literal=postgres-password=your_password \
  --from-literal=rustfs-access-key=your_key \
  --from-literal=rustfs-secret-key=your_key

# Or with External Secrets Operator, Sealed Secrets, Vault, etc.
```

## External RustFS या S3 उपयोग करना

यदि आपके पास पहले से RustFS या S3-compatible service है, built-in RustFS disable करें और endpoint pass करें:

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

NVIDIA GPUs पर GPU-accelerated Whisper transcription के लिए:

```yaml
whisper:
  enabled: true
  device: "cuda"
  model: "Systran/faster-whisper-large-v3"
  resources:
    limits:
      nvidia.com/gpu: 1
```

सुनिश्चित करें कि आपके cluster में [NVIDIA device plugin](https://github.com/NVIDIA/k8s-device-plugin) इंस्टॉल है।

## Scaling

Deployment zero-downtime upgrades के लिए `RollingUpdate` strategy उपयोग करता है। अपने traffic के आधार पर replicas scale करें:

```bash
kubectl scale deployment llamenos --replicas=3
```

या अपनी values file में `app.replicas` सेट करें। PostgreSQL advisory locks replicas में data consistency सुनिश्चित करते हैं।


## मॉनिटरिंग

### Health checks

Chart `/api/health` के विरुद्ध liveness, readiness, और startup probes कॉन्फ़िगर करता है:

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

### Logs

```bash
kubectl logs -l app.kubernetes.io/instance=llamenos -c app -f
```

## Upgrading

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

`RollingUpdate` strategy zero-downtime upgrades प्रदान करती है।

## Uninstalling

```bash
helm uninstall llamenos
```

> **नोट**: `helm uninstall` द्वारा PersistentVolumeClaims हटाए नहीं जाते। यदि आप सभी डेटा हटाना चाहते हैं तो उन्हें manually हटाएं:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## समस्या निवारण

### Pod CrashLoopBackOff में फंसा है

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

सामान्य कारण: missing secrets, गलत ADMIN_PUBKEY, PostgreSQL अनुपलब्ध, RustFS तैयार नहीं।

### Database connection errors

Cluster से PostgreSQL पहुंच योग्य है यह सत्यापित करें:

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Ingress काम नहीं कर रहा

Verify करें कि ingress controller चल रहा है और Ingress resource का address है:

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


## अगले चरण

- [Admin Guide](/docs/admin-guide) — हॉटलाइन कॉन्फ़िगर करें
- [Self-Hosting Overview](/docs/deploy/self-hosting) — deployment options की तुलना करें
- [Docker Compose Deployment](/docs/deploy/docker) — सरल विकल्प
