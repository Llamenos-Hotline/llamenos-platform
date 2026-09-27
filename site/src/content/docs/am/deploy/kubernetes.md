---
title: "መተግበር: Kubernetes (Helm)"
description: ላሜኖስን ወደ Kubernetes በይፋዊው Helm chart ያስተናግዱ።
---

ይህ መመሪያ ላሜኖስን ወደ Kubernetes ክላስተር በይፋዊው Helm chart ለመተግበር ያስተምርዎታል። ይህ chart መተግበሪያውን፣ RustFS ማከማቻውን፣ WebSocket relay WebSocket relayን፣ እና አማራጭ signal-notifier/sip-bridge አገልግሎቶችን እንደ የተለዩ መተግበርያዎች ያስተዳድራል። PostgreSQL ዳታቤዝ ያቅርቡ።

## ቅድመ ሁኔታዎች

- Kubernetes ክላስተር (v1.24+) — የሚተዳደር (EKS፣ GKE፣ AKS) ወይም ራስ-ማስተናገድ
- PostgreSQL 14+ ኢንስታንስ (የሚተዳደር RDS/Cloud SQL የሚመከር፣ ወይም ራስ-ማስተናገድ)
- [Helm](https://helm.sh/) v3.10+
- [kubectl](https://kubernetes.io/docs/tasks/tools/) ለክላስተርዎ የተዋቀረ
- የIngress መቆጣጠሪያ (NGINX Ingress፣ Traefik፣ ወዘተ.)
- cert-manager (አማራጭ፣ ለራስ-ሰር TLS ሰርተፊኬቶች)

## 1. Chart ያጫኑ

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

ወይም ለተደጋጋሚ መተግበርያዎች `values-production.yaml` ፋይል ይፍጠሩ፦

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
  # Telephony (ለድምፅ ቢያንስ አንድ አስፈላጊ ነው):
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
  enabled: false   # signal-notifier sidecar ለማንቃት ወደ true ይቀይሩ

sipBridge:
  enabled: false   # SIP bridge ለማንቃት (Asterisk/FreeSWITCH/Kamailio) ወደ true ይቀይሩ
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

ከዚያ ያጫኑ፦

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## 2. መተግበርያውን ያረጋግጡ

```bash
# Pods እየሰሩ እንደሆነ ያረጋግጡ
kubectl get pods -l app.kubernetes.io/instance=llamenos

# የመተግበሪያ ጤና ያረጋግጡ
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# -> {"status":"ok"}
```

## 3. DNS ያዋቅሩ

ዶሜንዎን ወደ ingress መቆጣጠሪያው ውጫዊ IP ወይም load balancer ያቅኑ፦

```bash
kubectl get ingress llamenos
```

## 4. የመጀመሪያ ማዋቀር

በአሳሽዎ ውስጥ `https://hotline.yourdomain.com` ክፈቱ እና የማዋቀሪያ ዊዘርዱን ይከተሉ፦

1. **የአስተዳዳሪ መለያዎን ይፍጠሩ** — የመጠሪያ ስም እና የPINዎን ያዘጋጁ
2. **ሞቃዲያንዎን ይሰይሙ** — በመተግበሪያው ውስጥ የሚታየውን የመጠሪያ ስም ያዘጋጁ
3. **ሰርጦችን ይምረጡ** — Voice፣ SMS፣ WhatsApp፣ Signal፣ እና/ወይም Reports ያንቁ
4. **አቅራቢዎችን ያዋቅሩ** — ለየትኛውም የታከለ ሰርጥ የማስረጃ መረጃ ያስገቡ
5. **ገምግመው ይጨርሱ**

## cert-manager አዋህድ

[cert-manager](https://cert-manager.io/) ካለዎት፣ ለራስ-ሰር TLS የክላስተር issuer ያዋቅሩ፦

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

ያመለክቱት፣ ከዚያ በingress annotations ውስጥ ያጣቅሱት (ከዚህ በፊት በላይ `values-production.yaml` ውስጥ ተካትቷል)፦

```yaml
ingress:
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
```

cert-manager በራስ-ሰር TLS ሰርተፊኬቶችን በLet's Encrypt በኩል ያዘጋጃል እና ያደሳል።

## External Secrets Operator

ለምርት፣ ሚስጥራትን በቀጥታ በHelm values ውስጥ አይስቀሉ። [External Secrets Operator](https://external-secrets.io/) ለሚስጥር storeዎ (AWS SSM፣ Vault፣ GCP Secret Manager፣ ወዘተ.) ለማመሳሰል ይጠቀሙ።

### 1. ExternalSecret ይፍጠሩ

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
    name: my-secret-store   # የእርስዎ ClusterSecretStore ወይም SecretStore
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

### 2. በHelm values ውስጥ ያጣቅሱ

```yaml
secrets:
  existingSecret: llamenos-secrets
```

አማራጭ፣ ሚስጥርን በእጅ ይፍጠሩ እና በተመሳሳይ መንገድ ያጣቅሱት፦

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

[Prometheus Operator](https://prometheus-operator.dev/) ካለዎት፣ በvaluesዎ ውስጥ `ServiceMonitor` ን ያንቁ፦

```yaml
monitoring:
  enabled: true
  serviceMonitor:
    namespace: monitoring    # Prometheus የተጫነበት namespace
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack
```

ይህ chart `/metrics` ን በapp service ላይ ያጋራል እና `ServiceMonitor` ን እንደ Prometheus selectorዎ ያዋቅራል።

### Health probes

ይህ chart liveness፣ readiness፣ እና startup probesን በ`/health/live` እና `/health/ready` ላይ ያዋቅራል፦

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

### መዝገቦች

```bash
kubectl logs -l app.kubernetes.io/instance=llamenos -c app -f
```

## Chart ውቅር መመሪያ

### መተግበሪያ

| ፓራሜትር | መግለጫ | ነባሪ |
|-----------|-------------|---------|
| `app.image.repository` | የኮንቴይነር ምስል | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | የምስል tag | Chart appVersion |
| `app.image.pullPolicy` | Pull policy | `IfNotPresent` |
| `app.port` | የመተግበሪያ ፖርት | `3000` |
| `app.replicas` | Pod replicas | `2` |
| `app.resources` | CPU/ማህደረ ትውስታ requests እና limits | `{}` |
| `app.env` | ተጨማሪ environment ተለዋዋጮች | `{}` |

### PostgreSQL

| ፓራሜትር | መግለጫ | ነባሪ |
|-----------|-------------|---------|
| `postgres.host` | PostgreSQL hostname (አስፈላጊ) | `""` |
| `postgres.port` | PostgreSQL ፖርት | `5432` |
| `postgres.database` | የዳታቤዝ ስም | `llamenos` |
| `postgres.user` | የዳታቤዝ ተጠቃሚ | `llamenos` |
| `postgres.poolSize` | የግንኙነት pool መጠን | `10` |

### ሚስጥራት

| ፓራሜትር | መግለጫ | ነባሪ |
|-----------|-------------|---------|
| `secrets.postgresPassword` | የPostgreSQL ይለፍቃል (አስፈላጊ) | `""` |
| `secrets.hmacSecret` | HMAC የመፈረም key — 64 hex ቁምፊዎች (አስፈላጊ) | `""` |
| `secrets.serverWebSocketSecret` | የሰርቨር WebSocket identity key — 64 hex ቁምፊዎች (አስፈላጊ) | `""` |
| `secrets.twilioAccountSid` | Twilio Account SID | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token | `""` |
| `secrets.twilioPhoneNumber` | Twilio የስልክ ቁጥር (E.164) | `""` |
| `secrets.existingSecret` | አስቀድሞ የነበረ Kubernetes Secret ይጠቀሙ | `""` |

> **ጠቃሚ ምክር**: ለምርት፣ `secrets.existingSecret` ከExternal Secrets Operator፣ Sealed Secrets፣ ወይም Vault ጋር ይጠቀሙ።

### RustFS

| ፓራሜትር | መግለጫ | ነባሪ |
|-----------|-------------|---------|
| `RustFS.enabled` | RustFS ን ይተግብሩ | `true` |
| `RustFS.image.repository` | RustFS ምስል | `RustFS/RustFS` |
| `RustFS.image.tag` | RustFS tag | `latest` |
| `RustFS.persistence.size` | የመረጃ ኮሎም መጠን | `50Gi` |
| `RustFS.persistence.storageClass` | Storage class | `""` |
| `RustFS.credentials.accessKey` | RustFS root ተጠቃሚ (አስፈላጊ) | `""` |
| `RustFS.credentials.secretKey` | RustFS root ይለፍቃል (አስፈላጊ) | `""` |
| `RustFS.resources` | CPU/ማህደረ ትውስታ requests እና limits | `{}` |

### WebSocket relay

| ፓራሜትር | መግለጫ | ነባሪ |
|-----------|-------------|---------|
| `WebSocket relay.enabled` | WebSocket relay ን ይተግብሩ | `true` |
| `WebSocket relay.image.repository` | WebSocket relay ምስል | `dockurr/WebSocket relay` |
| `WebSocket relay.image.tag` | WebSocket relay tag | `latest` |
| `WebSocket relay.resources` | CPU/ማህደረ ትውስታ requests እና limits | `{}` |

> WebSocket relay ማዕከላዊ አገልግሎት ነው — የበጊዜ ለውጥ ክስተቶች (ጥሪዎች፣ ማሳወቂያዎች፣ hub ሁኔታ) ይፈልጉታል። `WebSocket relay.enabled: true` ይይዙ።

### signal-notifier

| ፓራሜትር | መግለጫ | ነባሪ |
|-----------|-------------|---------|
| `signalNotifier.enabled` | signal-notifier sidecar ን ይተግብሩ | `false` |
| `signalNotifier.image.repository` | signal-notifier ምስል | `ghcr.io/rhonda-rodododo/llamenos-signal-notifier` |
| `signalNotifier.resources` | CPU/ማህደረ ትውስታ requests እና limits | `{}` |

### SIP bridge

| ፓራሜትር | መግለጫ | ነባሪ |
|-----------|-------------|---------|
| `sipBridge.enabled` | sip-bridge ን ይተግብሩ | `false` |
| `sipBridge.pbxType` | Backend: `asterisk`፣ `freeswitch`፣ ወይም `kamailio` | `asterisk` |
| `sipBridge.resources` | CPU/ማህደረ ትውስታ requests እና limits | `{}` |

### Monitoring

| ፓራሜትር | መግለጫ | ነባሪ |
|-----------|-------------|---------|
| `monitoring.enabled` | ServiceMonitor ይፍጠሩ | `false` |
| `monitoring.serviceMonitor.interval` | Scrape interval | `30s` |
| `monitoring.serviceMonitor.scrapeTimeout` | Scrape timeout | `10s` |
| `monitoring.serviceMonitor.namespace` | ServiceMonitor namespace | ከrelease ጋር ተመሳሳይ |
| `monitoring.serviceMonitor.labels` | ተጨማሪ labels ለPrometheus selector | `{}` |

### Ingress

| ፓራሜትር | መግለጫ | ነባሪ |
|-----------|-------------|---------|
| `ingress.enabled` | Ingress resource ይፍጠሩ | `true` |
| `ingress.className` | Ingress class | `nginx` |
| `ingress.annotations` | Ingress annotations | `{}` |
| `ingress.hosts` | Host ደንቦች | values.yaml ይመልከቱ |
| `ingress.tls` | TLS ውቅር | `[]` |

### Service account

| ፓራሜትር | መግለጫ | ነባሪ |
|-----------|-------------|---------|
| `serviceAccount.create` | ServiceAccount ይፍጠሩ | `true` |
| `serviceAccount.annotations` | SA annotations (ለምሳሌ፣ AWS ላይ IRSA) | `{}` |
| `serviceAccount.name` | SA ስም ይተኩ | `""` |

## ውጫዊ S3-ተኳሃኝ ማከማቻን መጠቀም

ቀድሞ ካለዎት RustFS፣ RustFS፣ ወይም ሌላ S3-ተኳሃኝ አገልግሎት፣ የተሰራውን RustFS ያሰናክሉ፦

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

## የምርት ጥንካሬ ቼክሊስት

ከህይወት ለመግባት በፊት፦

- [ ] **ሚስጥራት በESO ወይም Sealed Secrets** — ሚስጥራትን በvalues ፋይሎች ውስጥ ከቶ አይስቀሉ
- [ ] **Resource requests እና limits** በሁሉም መተግበርያዎች ላይ ተዘጋጅተዋል
- [ ] **PodDisruptionBudget** ተዋቅሯል (`minAvailable: 1`) ለዜሮ-ሰዓት ጊዜ drains
- [ ] **NetworkPolicy** ingressን ወደ app pod ከingress controller ብቻ እንዲገደብ ያደርጋል
- [ ] **የማንበብ-ብቻ root filesystem** በapp ኮንቴይነር ላይ (`securityContext.readOnlyRootFilesystem: true`)
- [ ] **የመሠረት-አይደለም ተጠቃሚ** በኮንቴይነር ውስጥ (`securityContext.runAsNonRoot: true`)
- [ ] **PostgreSQL TLS** ተንብሯል (`postgres.sslMode: require` በvalues ውስጥ ያዘጋጁ)
- [ ] **RustFS TLS** ወይም mTLS በapp እና RustFS መካከል
- [ ] **cert-manager ClusterIssuer** ለራስ-ሰር Let's Encrypt ማደስ ተዋቅሯል
- [ ] **Prometheus ServiceMonitor** ተንብሯል እና ይወዳድራል
- [ ] **Liveness/readiness probes** ከተተግበረ በኋላ ተረጋግጠዋል
- [ ] **RBAC** — ServiceAccount ከአነስተኛ ፍቃዶች ጋር
- [ ] **Image pull policy** ወደ `IfNotPresent` (አይደለም `Always`) ለተረጋጋ መተግበርያዎች ተዘጋጅቷል
- [ ] **Ingress rate limiting** annotations ለዝርፊያ መቋቋም ተዘጋጅተዋል

ለምሳሌ NetworkPolicy፦

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

## ማስተፋጽም

ይህ መተግበርያ `RollingUpdate` ስትራቴጂን ይጠቀማል ለዜሮ-ሰዓት upgrades። Replicasን በትራፊክዎ መሰረት ያስተፋጽሙ፦

```bash
kubectl scale deployment llamenos --replicas=3
```

ወይም በvalues ፋይልዎ ውስጥ `app.replicas` ያዘጋጁ። PostgreSQL advisory locks በreplicas መካከል የመረጃ ተመላላሽነት ያረጋግጣሉ።

## ማዘመን

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

የ`RollingUpdate` ስትራቴጂ ዜሮ-ሰዓት upgrades ያቀርባል።

## ማስወገድ

```bash
helm uninstall llamenos
```

> **ማስታወሻ**: PersistentVolumeClaims በ`helm uninstall` አይሰረዙም። ሁሉንም መረጃ ለማስወገድ በእጅ ያስወግዱት፦
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## ችግር መፍቻ

### Pod በCrashLoopBackOff ተይዟል

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

ተለመዱ ምክንያቶች፦ ጠፍቷቸው የነበሩ ሚስጥራት (`hmacSecret`፣ `serverWebSocketSecret`)፣ PostgreSQL አይደረስም፣ RustFS ዝግጁ አይደለም።

### የዳታቤዝ ግንኙነት ስህተቶች

PostgreSQL ከክላስተሩ ሊደረስ እንደሚችል ያረጋግጡ፦

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- \
  psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Ingress አይሰራም

Ingress controller እየሰራ እና Ingress resource አድራሻ እንዳለው ያረጋግጡ፦

```bash
kubectl get ingress llamenos
kubectl describe ingress llamenos
```

### ሰርተፊኬት አልተሰጠም

cert-manager የሰርተፊኬት ሁኔታን ያረጋግጡ፦

```bash
kubectl get certificate llamenos-tls
kubectl describe certificate llamenos-tls
kubectl get certificaterequest
kubectl describe certificaterequest
```

ተለመዱ ምክንያቶች፦ DNS ገና አልተሰራጨም፣ ፖርት 80/443 ክፍት አይደለም፣ ClusterIssuer ተሳስቷል።

## ቀጣይ ደረጃዎች

- [Docker Compose መተግበርያ](/docs/en/deploy/docker) — ቀላል አንድ-ሰርቨር አማራጭ
- [Self-Hosting Overview](/docs/en/deploy/self-hosting) — የመተግበርያ አማራጮችን ያወዳድሩ
- [Telephony Providers](/docs/en/deploy/providers/) — የድምፅ አቅራቢዎችን ያዋቅሩ
