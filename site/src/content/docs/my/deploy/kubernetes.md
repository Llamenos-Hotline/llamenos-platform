---
title: "ဖြန့်ကျက်ခြင်း: Kubernetes (Helm)"
description: တရားဝင် Helm chart ကိုအသုံးပြု၍ Llamenos ကို Kubernetes သို့ ဖြန့်ကျက်ပါ။
---

ဤလမ်းညွှန်သည် တရားဝင် Helm chart ကိုအသုံးပြု၍ Llamenos ကို Kubernetes cluster တစ်ခုသို့ ဖြန့်ကျက်ခြင်းအကြောင်း အကျုံးဝင်ပါသည်။ Chart သည် အပလီကေးရှင်း၊ RustFS သိုလှောင်မှု၊ WebSocket relay နှင့် ထည့်သွင်းစရာ signal-notifier/sip-bridge ဝန်ဆောင်မှုများကို သီးခြားဖြန့်ကျက်မှုများအဖြစ် စီမံပါသည်။ သင်က PostgreSQL ဒေတာဘေ့စ်ကို ထောက်ပံ့ပေးပါသည်။

## လိုအပ်ချက်များ

- Kubernetes cluster (v1.24+) — စီမံခန့်ခွဲထားသော (EKS, GKE, AKS) သို့မဟုတ် ကိုယ်တိုင်အိမ်ရှင်
- PostgreSQL 14+ instance (managed RDS/Cloud SQL အကြံပြုသည်၊ သို့မဟုတ် ကိုယ်တိုင်အိမ်ရှင်)
- [Helm](https://helm.sh/) v3.10+
- သင့် cluster အတွက် ပြင်ဆင်ထားသော [kubectl](https://kubernetes.io/docs/tasks/tools/)
- Ingress controller (NGINX Ingress, Traefik စသည်)
- cert-manager (ထည့်သွင်းစရာ၊ အလိုအလျောက် TLS လက်မှတ်များအတွက်)

## ၁။ Chart ကိုထည့်သွင်းပါ

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

သို့မဟုတ် ပြန်လည်ထုတ်လုပ်နိုင်သော ဖြန့်ကျက်မှုများအတွက် `values-production.yaml` ဖိုင်ကို ဖန်တီးပါ-

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
  # တယ်လီဖုန်း (အသံအတွက် အနည်းဆုံးတစ်ခုလိုအပ်သည်):
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
  enabled: false   # signal-notifier sidecar ကိုဖွင့်ရန် true သတ်မှတ်ပါ

sipBridge:
  enabled: false   # SIP တံတားကိုဖွင့်ရန် true သတ်မှတ်ပါ (Asterisk/FreeSWITCH/Kamailio)
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

ထို့နောက် ထည့်သွင်းပါ-

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## ၂။ ဖြန့်ကျက်မှုကို အတည်ပြုပါ

```bash
# Pod များအလုပ်လုပ်နေကြောင်း စစ်ဆေးပါ
kubectl get pods -l app.kubernetes.io/instance=llamenos

# အက်ပ်ကျန်းမာရေးကို စစ်ဆေးပါ
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# -> {"status":"ok"}
```

## ၃။ DNS ကိုပြင်ဆင်ပါ

သင့်ဒိုမိုင်းကို ingress controller ၏ ပြင်ပ IP သို့မဟုတ် load balancer သို့ ညွှန်ပြပါ-

```bash
kubectl get ingress llamenos
```

## ၄။ ကနဦးသတ်မှတ်ခြင်း

သင့်ဘရောက်ဆာတွင် `https://hotline.yourdomain.com` ကိုဖွင့်ပြီး သတ်မှတ်ခြင်းဝီဇာကို လိုက်နာပါ-

၁။ **သင့်အက်ဒ်မင်အကောင့်ကို ဖန်တီးပါ** — ပြသမည့်အမည်နှင့် သင့် PIN ကို သတ်မှတ်ပါ
၂။ **သင့်ဟော့လိုင်းကို အမည်ပေးပါ** — အက်ပ်တွင် ပြသမည့် နာမည်ကို သတ်မှတ်ပါ
၃။ **ချန်နယ်များကို ရွေးချယ်ပါ** — အသံ၊ SMS၊ WhatsApp၊ Signal နှင့်/သို့မဟုတ် အစီရင်ခံစာများကို ဖွင့်ပါ
၄။ **ဝန်ဆောင်မှုပေးသူများကို ပြင်ဆင်ပါ** — ဖွင့်ထားသော ချန်နယ်တစ်ခုစီအတွက် အထောက်အထားများကို ထည့်သွင်းပါ
၅။ **ပြန်လည်သုံးသပ်ပြီး အပြီးသတ်ပါ**

## cert-manager ပေါင်းစည်းခြင်း

သင့်တွင် [cert-manager](https://cert-manager.io/) ထည့်သွင်းထားပါက၊ အလိုအလျောက် TLS အတွက် cluster issuer ကိုပြင်ဆင်ပါ-

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

၎င်းကိုအသုံးပြုပါ၊ ထို့နောက် သင့် ingress annotations တွင် ကိုးကားပါ (အထက်ပါ `values-production.yaml` တွင် ထည့်သွင်းပြီးသား):

```yaml
ingress:
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
```

cert-manager သည် Let's Encrypt မှတစ်ဆင့် TLS လက်မှတ်များကို အလိုအလျောက် ထုတ်ပေးပြီး သက်တမ်းတိုးပေးပါမည်။

## External Secrets Operator

အသားတင်အတွက်၊ Helm values တွင် လျှို့ဝှက်ချက်များကို တိုက်ရိုက်ထည့်ခြင်းကို ရှောင်ကြဉ်ပါ။ သင့်လျှို့ဝှက်သိုလှောင်မှု (AWS SSM, Vault, GCP Secret Manager စသည်) မှ လျှို့ဝှက်ချက်များကို ထပ်တူပြုရန် [External Secrets Operator](https://external-secrets.io/) ကို အသုံးပြုပါ။

### ၁။ ExternalSecret တစ်ခု ဖန်တီးပါ

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
    name: my-secret-store   # သင့် ClusterSecretStore သို့မဟုတ် SecretStore
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

### ၂။ Helm values တွင် ကိုးကားပါ

```yaml
secrets:
  existingSecret: llamenos-secrets
```

တနည်းအားဖြင့်၊ လျှို့ဝှက်ချက်ကို ကိုယ်တိုင်ဖန်တီးပြီး အလားတူနည်းဖြင့် ကိုးကားပါ-

```bash
kubectl create secret generic llamenos-secrets \
  --from-literal=postgres-password=your_password \
  --from-literal=hmac-secret=your_hmac_hex \
  --from-literal=server-WebSocket-secret=your_WebSocket_hex \
  --from-literal=RustFS-access-key=your_key \
  --from-literal=RustFS-secret-key=your_secret
```

## Prometheus စောင့်ကြည့်ခြင်း

### ServiceMonitor

သင့်တွင် [Prometheus Operator](https://prometheus-operator.dev/) ရှိပါက သင့် values တွင် `ServiceMonitor` ကိုဖွင့်ပါ-

```yaml
monitoring:
  enabled: true
  serviceMonitor:
    namespace: monitoring    # Prometheus ထည့်သွင်းထားသော namespace
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack
```

Chart သည် အက်ပ်ဝန်ဆောင်မှုတွင် `/metrics` ကိုထုတ်ဖော်ပြီး သင့် Prometheus selector နှင့်ကိုက်ညီရန် `ServiceMonitor` ကိုပြင်ဆင်ပါသည်။

### ကျန်းမာရေး probes များ

Chart သည် liveness, readiness နှင့် startup probes များကို `/health/live` နှင့် `/health/ready` တို့တွင် ပြင်ဆင်ပါသည်-

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

### Log များ

```bash
kubectl logs -l app.kubernetes.io/instance=llamenos -c app -f
```

## Chart ပြင်ဆင်မှုကိုးကားချက်

### အပလီကေးရှင်း

| ကန့်သတ်ချက် | ဖော်ပြချက် | ပုံသေ |
|---|---|---|
| `app.image.repository` | Container image | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | Image tag | Chart appVersion |
| `app.image.pullPolicy` | Pull policy | `IfNotPresent` |
| `app.port` | အပလီကေးရှင်း port | `3000` |
| `app.replicas` | Pod replicas | `2` |
| `app.resources` | CPU/မှတ်ဉာဏ် တောင်းဆိုချက်များနှင့် ကန့်သတ်ချက်များ | `{}` |
| `app.env` | ထပ်ဆောင်း environment variables | `{}` |

### PostgreSQL

| ကန့်သတ်ချက် | ဖော်ပြချက် | ပုံသေ |
|---|---|---|
| `postgres.host` | PostgreSQL hostname (လိုအပ်သည်) | `""` |
| `postgres.port` | PostgreSQL port | `5432` |
| `postgres.database` | ဒေတာဘေ့စ်အမည် | `llamenos` |
| `postgres.user` | ဒေတာဘေ့စ်အသုံးပြုသူ | `llamenos` |
| `postgres.poolSize` | ချိတ်ဆက်မှုအကန့်အရွယ်အစား | `10` |

### လျှို့ဝှက်ချက်များ

| ကန့်သတ်ချက် | ဖော်ပြချက် | ပုံသေ |
|---|---|---|
| `secrets.postgresPassword` | PostgreSQL စကားဝှက် (လိုအပ်သည်) | `""` |
| `secrets.hmacSecret` | HMAC လက်မှတ်သော့ — hex 64 လုံး (လိုအပ်သည်) | `""` |
| `secrets.serverWebSocketSecret` | ဆာဗာ WebSocket အထောက်အထားသော့ — hex 64 လုံး (လိုအပ်သည်) | `""` |
| `secrets.twilioAccountSid` | Twilio အကောင့် SID | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token | `""` |
| `secrets.twilioPhoneNumber` | Twilio ဖုန်းနံပါတ် (E.164) | `""` |
| `secrets.existingSecret` | ရှိပြီးသား Kubernetes Secret ကိုသုံးပါ | `""` |

> **အကြံပြုချက်**: အသားတင်အတွက် External Secrets Operator, Sealed Secrets သို့မဟုတ် Vault ဖြင့် `secrets.existingSecret` ကိုသုံးပါ။

### RustFS

| ကန့်သတ်ချက် | ဖော်ပြချက် | ပုံသေ |
|---|---|---|
| `RustFS.enabled` | RustFS ဖြန့်ကျက်ခြင်း | `true` |
| `RustFS.image.repository` | RustFS image | `RustFS/RustFS` |
| `RustFS.image.tag` | RustFS tag | `latest` |
| `RustFS.persistence.size` | ဒေတာ volume အရွယ်အစား | `50Gi` |
| `RustFS.persistence.storageClass` | သိုလှောင်မှုအတန်းအစား | `""` |
| `RustFS.credentials.accessKey` | RustFS root user (လိုအပ်သည်) | `""` |
| `RustFS.credentials.secretKey` | RustFS root စကားဝှက် (လိုအပ်သည်) | `""` |
| `RustFS.resources` | CPU/မှတ်ဉာဏ် တောင်းဆိုချက်များနှင့် ကန့်သတ်ချက်များ | `{}` |

### WebSocket relay

| ကန့်သတ်ချက် | ဖော်ပြချက် | ပုံသေ |
|---|---|---|
| `WebSocket relay.enabled` | WebSocket relay ဖြန့်ကျက်ခြင်း | `true` |
| `WebSocket relay.image.repository` | WebSocket relay image | `dockurr/WebSocket relay` |
| `WebSocket relay.image.tag` | WebSocket relay tag | `latest` |
| `WebSocket relay.resources` | CPU/မှတ်ဉာဏ် တောင်းဆိုချက်များနှင့် ကန့်သတ်ချက်များ | `{}` |

> WebSocket relay သည် အဓိကဝန်ဆောင်မှုဖြစ်သည် — အချိန်နှင့်တပြေးညီ ဖြစ်ရပ်များ (ခေါ်ဆိုမှုများ၊ အကြောင်းကြားချက်များ၊ hub အခြေအနေ) အတွက် ၎င်းလိုအပ်ပါသည်။ `WebSocket relay.enabled: true` ကိုထားရှိပါ။

### signal-notifier

| ကန့်သတ်ချက် | ဖော်ပြချက် | ပုံသေ |
|---|---|---|
| `signalNotifier.enabled` | signal-notifier sidecar ဖြန့်ကျက်ခြင်း | `false` |
| `signalNotifier.image.repository` | signal-notifier image | `ghcr.io/rhonda-rodododo/llamenos-signal-notifier` |
| `signalNotifier.resources` | CPU/မှတ်ဉာဏ် တောင်းဆိုချက်များနှင့် ကန့်သတ်ချက်များ | `{}` |

### SIP တံတား

| ကန့်သတ်ချက် | ဖော်ပြချက် | ပုံသေ |
|---|---|---|
| `sipBridge.enabled` | sip-bridge ဖြန့်ကျက်ခြင်း | `false` |
| `sipBridge.pbxType` | Backend: `asterisk`, `freeswitch`, သို့မဟုတ် `kamailio` | `asterisk` |
| `sipBridge.resources` | CPU/မှတ်ဉာဏ် တောင်းဆိုချက်များနှင့် ကန့်သတ်ချက်များ | `{}` |

### စောင့်ကြည့်ခြင်း

| ကန့်သတ်ချက် | ဖော်ပြချက် | ပုံသေ |
|---|---|---|
| `monitoring.enabled` | ServiceMonitor ဖန်တီးခြင်း | `false` |
| `monitoring.serviceMonitor.interval` | Scrape interval | `30s` |
| `monitoring.serviceMonitor.scrapeTimeout` | Scrape timeout | `10s` |
| `monitoring.serviceMonitor.namespace` | ServiceMonitor အတွက် Namespace | Release နှင့်အတူတူ |
| `monitoring.serviceMonitor.labels` | Prometheus selector အတွက် ထပ်ဆောင်း labels | `{}` |

### Ingress

| ကန့်သတ်ချက် | ဖော်ပြချက် | ပုံသေ |
|---|---|---|
| `ingress.enabled` | Ingress resource ဖန်တီးခြင်း | `true` |
| `ingress.className` | Ingress class | `nginx` |
| `ingress.annotations` | Ingress annotations | `{}` |
| `ingress.hosts` | Host rules | values.yaml တွင်ကြည့်ပါ |
| `ingress.tls` | TLS ပြင်ဆင်မှု | `[]` |

### ဝန်ဆောင်မှုအကောင့်

| ကန့်သတ်ချက် | ဖော်ပြချက် | ပုံသေ |
|---|---|---|
| `serviceAccount.create` | ServiceAccount ဖန်တီးခြင်း | `true` |
| `serviceAccount.annotations` | SA annotations (ဥပမာ IRSA for AWS) | `{}` |
| `serviceAccount.name` | SA အမည်ကို ပြောင်းလဲခြင်း | `""` |

## ပြင်ပ S3-compatible သိုလှောင်မှုကို အသုံးပြုခြင်း

သင့်တွင် RustFS သို့မဟုတ် အခြား S3-compatible ဝန်ဆောင်မှုရှိပြီးသားဖြစ်ပါက built-in RustFS ကိုပိတ်ပါ-

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

## အသားတင်ခိုင်မာစေရေး စစ်ဆေးစာရင်း

အသက်မဝင်မီ:

- [ ] **ESO သို့မဟုတ် Sealed Secrets မှတစ်ဆင့် လျှို့ဝှက်ချက်များ** — values ဖိုင်များတွင် လျှို့ဝှက်ချက်များကို ဘယ်တော့မှ commit မလုပ်ပါ
- [ ] ဖြန့်ကျက်မှုအားလုံးတွင် **အရင်းအမြစ်တောင်းဆိုချက်များနှင့် ကန့်သတ်ချက်များ** သတ်မှတ်ထားပါ
- [ ] Zero-downtime drain အတွက် **PodDisruptionBudget** ပြင်ဆင်ထားပါ (`minAvailable: 1`)
- [ ] Ingress controller မှ app pod သို့သာ ဝင်ရောက်ခွင့်ကို ကန့်သတ်သော **NetworkPolicy**
- [ ] အက်ပ် container တွင် **Read-only root filesystem** (`securityContext.readOnlyRootFilesystem: true`)
- [ ] Container တွင် **Non-root user** (`securityContext.runAsNonRoot: true`)
- [ ] **PostgreSQL TLS** ဖွင့်ထားပါ (values တွင် `postgres.sslMode: require` သတ်မှတ်ပါ)
- [ ] အက်ပ်နှင့် RustFS ကြား **RustFS TLS** သို့မဟုတ် mTLS
- [ ] အလိုအလျောက် Let's Encrypt သက်တမ်းတိုးခြင်းအတွက် **cert-manager ClusterIssuer** ပြင်ဆင်ထားပါ
- [ ] **Prometheus ServiceMonitor** ဖွင့်ထားပြီး scraping လုပ်နေပါ
- [ ] ဖြန့်ကျက်ပြီးနောက် **Liveness/readiness probes** အတည်ပြုထားပါ
- [ ] **RBAC** — အနည်းဆုံးခွင့်ပြုချက်များဖြင့် ServiceAccount
- [ ] ကြိုတင်ခန့်မှန်းနိုင်သော ဖြန့်ကျက်မှုများအတွက် **Image pull policy** ကို `IfNotPresent` ( `Always` မဟုတ်) သတ်မှတ်ထားပါ
- [ ] အလွဲသုံးစားမှုလျှော့ချရန် **Ingress rate limiting** annotations သတ်မှတ်ထားပါ

NetworkPolicy နမူနာ:

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

## ချဲ့ထွင်ခြင်း

ဖြန့်ကျက်မှုသည် zero-downtime အဆင့်မြှင့်တင်မှုများအတွက် `RollingUpdate` နည်းဗျူဟာကို အသုံးပြုပါသည်။ သင့် traffic အပေါ်မူတည်၍ replicas ကိုချဲ့ပါ-

```bash
kubectl scale deployment llamenos --replicas=3
```

သို့မဟုတ် သင့် values ဖိုင်တွင် `app.replicas` ကိုသတ်မှတ်ပါ။ PostgreSQL advisory locks များသည် replicas များအနှံ့ ဒေတာညီညွတ်မှုကိုသေချာစေပါသည်။

## အဆင့်မြှင့်တင်ခြင်း

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

`RollingUpdate` နည်းဗျူဟာသည် zero-downtime အဆင့်မြှင့်တင်မှုများကို ပံ့ပိုးပါသည်။

## ဖြုတ်ခြင်း

```bash
helm uninstall llamenos
```

> **မှတ်ချက်**: `helm uninstall` ဖြင့် PersistentVolumeClaims များကို ဖျက်မည်မဟုတ်ပါ။ ဒေတာအားလုံးကိုဖယ်ရှားလိုပါက ၎င်းတို့ကို ကိုယ်တိုင်ဖျက်ပါ-
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## ပြဿနာဖြေရှင်းခြင်း

### Pod CrashLoopBackOff တွင်တွယ်ကပ်နေခြင်း

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

အဖြစ်များသော အကြောင်းရင်းများ: လျှို့ဝှက်ချက်များ (`hmacSecret`, `serverWebSocketSecret`) ပျောက်ဆုံးနေခြင်း၊ PostgreSQL သို့မရောက်ရှိနိုင်ခြင်း၊ RustFS အဆင်သင့်မဖြစ်ခြင်း။

### ဒေတာဘေ့စ်ချိတ်ဆက်မှုအမှားများ

PostgreSQL ကို cluster မှရောက်ရှိနိုင်ကြောင်း စစ်ဆေးပါ-

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- \
  psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Ingress အလုပ်မလုပ်ခြင်း

Ingress controller အလုပ်လုပ်နေပြီး Ingress resource တွင် လိပ်စာရှိကြောင်း စစ်ဆေးပါ-

```bash
kubectl get ingress llamenos
kubectl describe ingress llamenos
```

### လက်မှတ်မထုတ်ပေးခြင်း

cert-manager လက်မှတ်အခြေအနေကို စစ်ဆေးပါ-

```bash
kubectl get certificate llamenos-tls
kubectl describe certificate llamenos-tls
kubectl get certificaterequest
kubectl describe certificaterequest
```

အဖြစ်များသော အကြောင်းရင်းများ: DNS မပျံ့နှံ့သေးခြင်း၊ port 80/443 မဖွင့်ထားခြင်း၊ ClusterIssuer မှားယွင်းပြင်ဆင်ထားခြင်း။

## နောက်အဆင့်များ

- [Docker Compose ဖြန့်ကျက်ခြင်း](/docs/en/deploy/docker) — ပိုမိုရိုးရှင်းသော ဆာဗာတစ်လုံးတည်း အခြားရွေးချယ်စရာ
- [ကိုယ်တိုင်အိမ်ရှင် ခြုံငုံသုံးသပ်ချက်](/docs/en/deploy/self-hosting) — ဖြန့်ကျက်ရွေးချယ်စရာများကို နှိုင်းယှဉ်ပါ
- [တယ်လီဖုန်းဝန်ဆောင်မှုပေးသူများ](/docs/en/deploy/providers/) — အသံဝန်ဆောင်မှုပေးသူများကို ပြင်ဆင်ပါ
