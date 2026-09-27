---
title: "Belavkirin: Kubernetes (Helm)"
description: Llamenos bi şemaya Helm a fermî belav bikin li ser Kubernetes.
---

Ev rêber belavkirina Llamenos li ser klusterek Kubernetes bi şemaya Helm a fermî vedigire. Şema sepana, depoya RustFS, WebSocket relay WebSocket relay, û karûbarên bixwece yên signal-notifier/sip-bridge wekî belavkirinên cuda birêve dibe. Hûn danegehek PostgreSQL pêşkêş dikin.

## Pêşdibistan

- Klusterek Kubernetes (v1.24+) — rêvebirin (EKS, GKE, AKS) an xwe-sazkirî
- Danegehek PostgreSQL 14+ (RDS/Cloud SQL ya rêvebirinê tê pêşniyaz kirin, an xwe-sazkirî)
- [Helm](https://helm.sh/) v3.10+
- [kubectl](https://kubernetes.io/docs/tasks/tools/) ji bo klustera xwe mîheng kirî
- Kontrolerek ingress (NGINX Ingress, Traefik, hwd.)
- cert-manager (bixwece, ji bo sertîfîkayên TLS yên otomatîk)

## 1. Şema saz bikin

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

An jî pelê `values-production.yaml` ji bo belavkirinên dubarekirî çêbikin:

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
  enabled: false   # ji bo signal-notifier sidecar çalak bikin veguherînin true

sipBridge:
  enabled: false   # ji bo SIP bridge (Asterisk/FreeSWITCH/Kamailio) çalak bikin veguherînin true
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

Piştre saz bikin:

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## 2. Belavkirinê piştrast bikin

```bash
# Kontrol bike ku podan li ser xwe ne
kubectl get pods -l app.kubernetes.io/instance=llamenos

# Tenduristiya sepana kontrol bike
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# -> {"status":"ok"}
```

## 3. DNS mîheng bikin

Domaina xwe bi IP-ya derve an balansera barê ya kontrolerek ingress ve birêve bidin:

```bash
kubectl get ingress llamenos
```

## 4. Sazkirina destpêkê

`https://hotline.yourdomain.com` di geroka xwe de vekin û sêrbaziya sazkirinê bişopînin:

1. **Hesaba rêveberiya xwe çêbikin** — navê xuyangê û PIN-ê xwe mîheng bikin
2. **Navê xeta xwe binivîsin** — navê xuyangê ya ku di sepana de tê nîşandan mîheng bikin
3. **Kanal hilbijêrin** — Deng, SMS, WhatsApp, Signal, û/an Raportan çalak bikin
4. **Pêşkêşkeran mîheng bikin** — ji bo her kanala çalak erkdanê têkevin
5. **Kontrol bikin û temam bikin**

## Yekbûna cert-manager

Heke [cert-manager](https://cert-manager.io/) saz kirî ye, cluster issuer ji bo sertîfîkayên TLS yên otomatîk mîheng bikin:

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

Sepan bikin, paşê di annotations ingress de jê re bixebitin (berê di `values-production.yaml` yê jor de tê de ye):

```yaml
ingress:
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
```

cert-manager bi otomatîk sertîfîkayên TLS bi riya Let's Encrypt peyda dike û nûve dike.

## External Secrets Operator

Ji bo hilberînê, veşartiyên rasterast di nirxên Helm de nekin. [External Secrets Operator](https://external-secrets.io/) bikar bînin da ku veşartiyên ji dûgeha veşartiya xwe (AWS SSM, Vault, GCP Secret Manager, hwd.) hevdeng bikin.

### 1. ExternalSecretek çêbikin

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
    name: my-secret-store   # ClusterSecretStore an SecretStore-a we
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

### 2. Di nirxên Helm de jê re bixebitin

```yaml
secrets:
  existingSecret: llamenos-secrets
```

Bixwece, veşartî bi destan çêbikin û bi heman awayî jê re bixebitin:

```bash
kubectl create secret generic llamenos-secrets \
  --from-literal=postgres-password=your_password \
  --from-literal=hmac-secret=your_hmac_hex \
  --from-literal=server-WebSocket-secret=your_WebSocket_hex \
  --from-literal=RustFS-access-key=your_key \
  --from-literal=RustFS-secret-key=your_secret
```

## Çavdêriya Prometheus

### ServiceMonitor

Heke [Prometheus Operator](https://prometheus-operator.dev/) xebitînin, `ServiceMonitor` di nirxên xwe de çalak bikin:

```yaml
monitoring:
  enabled: true
  serviceMonitor:
    namespace: monitoring    # namespace ku Prometheus tê de hatiye sazkirin
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack
```

Şema `/metrics` li ser karûbara sepanê eşkere dike û `ServiceMonitor` mîheng dike ku bi bijartekera Prometheus-a we re lihev bike.

### Pîşesaziyên tenduristiyê

Şema pîşesaziyên jîngehê, amadehiyê û destpêkirinê li dijî `/health/live` û `/health/ready` mîheng dike:

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

### Têketin

```bash
kubectl logs -l app.kubernetes.io/instance=llamenos -c app -f
```

## Kurteya mîhengkirina şemayê

### Sepan

| Parametre | Sermawecî | Default |
|-----------|-----------|---------|
| `app.image.repository` | Wêneyê konteynerê | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | Tagê wêneyê | Chart appVersion |
| `app.image.pullPolicy` | Polîtîkaya کشش | `IfNotPresent` |
| `app.port` | Porta sepanê | `3000` |
| `app.replicas` | Pod replicas | `2` |
| `app.resources` | Daxwaz û sînorkirinên CPU/bîr | `{}` |
| `app.env` | Guhertoyên jîngeyê yên zêdetir | `{}` |

### PostgreSQL

| Parametre | Sermawecî | Default |
|-----------|-----------|---------|
| `postgres.host` | Navê hostê PostgreSQL (pêwîst) | `""` |
| `postgres.port` | Porta PostgreSQL | `5432` |
| `postgres.database` | Navê danegehê | `llamenos` |
| `postgres.user` | Bikarhênerê danegehê | `llamenos` |
| `postgres.poolSize` | Mezinahiya poola girêdanê | `10` |

### Veşartî

| Parametre | Sermawecî | Default |
|-----------|-----------|---------|
| `secrets.postgresPassword` | Pêborîna PostgreSQL (pêwîst) | `""` |
| `secrets.hmacSecret` | Kilîta îmazkirina HMAC — 64 karakterên hex (pêwîst) | `""` |
| `secrets.serverWebSocketSecret` | Kilîta nasnameya WebSocket-ê ya serverê — 64 karakterên hex (pêwîst) | `""` |
| `secrets.twilioAccountSid` | Twilio Account SID | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token | `""` |
| `secrets.twilioPhoneNumber` | Hejmara telefonê ya Twilio (E.164) | `""` |
| `secrets.existingSecret` | Ji bo ku sekretek Kubernetes a heyî bikar bîne | `""` |

> **Şîret**: Ji bo hilberînê, `secrets.existingSecret` bi External Secrets Operator, Sealed Secrets, an Vault bikar bînin.

### RustFS

| Parametre | Sermawecî | Default |
|-----------|-----------|---------|
| `RustFS.enabled` | RustFS belav bike | `true` |
| `RustFS.image.repository` | Wêneyê RustFS | `RustFS/RustFS` |
| `RustFS.image.tag` | Tagê RustFS | `latest` |
| `RustFS.persistence.size` | Mezinahiya tomara daneyê | `50Gi` |
| `RustFS.persistence.storageClass` | Pola depoyê | `""` |
| `RustFS.credentials.accessKey` | Bikarhênerê rootê RustFS (pêwîst) | `""` |
| `RustFS.credentials.secretKey` | Pêborîna rootê RustFS (pêwîst) | `""` |
| `RustFS.resources` | Daxwaz û sînorkirinên CPU/bîr | `{}` |

### WebSocket relay

| Parametre | Sermawecî | Default |
|-----------|-----------|---------|
| `WebSocket relay.enabled` | WebSocket relay belav bike | `true` |
| `WebSocket relay.image.repository` | Wêneyê WebSocket relay | `dockurr/WebSocket relay` |
| `WebSocket relay.image.tag` | Tagê WebSocket relay | `latest` |
| `WebSocket relay.resources` | Daxwaz û sînorkirinên CPU/bîr | `{}` |

> WebSocket relay karûbarek bingehîn e — bûyerên bi-dem (bang, agahdarkirin, statûya hub) hewceyî wê ne. `WebSocket relay.enabled: true` bigrin.

### signal-notifier

| Parametre | Sermawecî | Default |
|-----------|-----------|---------|
| `signalNotifier.enabled` | signal-notifier sidecar belav bike | `false` |
| `signalNotifier.image.repository` | Wêneyê signal-notifier | `ghcr.io/rhonda-rodododo/llamenos-signal-notifier` |
| `signalNotifier.resources` | Daxwaz û sînorkirinên CPU/bîr | `{}` |

### SIP bridge

| Parametre | Sermawecî | Default |
|-----------|-----------|---------|
| `sipBridge.enabled` | sip-bridge belav bike | `false` |
| `sipBridge.pbxType` | Backend: `asterisk`, `freeswitch`, an `kamailio` | `asterisk` |
| `sipBridge.resources` | Daxwaz û sînorkirinên CPU/bîr | `{}` |

### Çavdêrî

| Parametre | Sermawecî | Default |
|-----------|-----------|---------|
| `monitoring.enabled` | ServiceMonitor çêbike | `false` |
| `monitoring.serviceMonitor.interval` | Navbera scraping | `30s` |
| `monitoring.serviceMonitor.scrapeTimeout` | Dema demkî ya scraping | `10s` |
| `monitoring.serviceMonitor.namespace` | Namespace ji bo ServiceMonitor | Wekî belavkirinê |
| `monitoring.serviceMonitor.labels` | Labelên zêdetir ji bo bijartekera Prometheus | `{}` |

### Ingress

| Parametre | Sermawecî | Default |
|-----------|-----------|---------|
| `ingress.enabled` | Çavkaniya Ingress çêbike | `true` |
| `ingress.className` | Pola ingress | `nginx` |
| `ingress.annotations` | Annotations ingress | `{}` |
| `ingress.hosts` | Rêgezên host | Binêre values.yaml |
| `ingress.tls` | Mîhengkirina TLS | `[]` |

### Hesa karûbarê

| Parametre | Sermawecî | Default |
|-----------|-----------|---------|
| `serviceAccount.create` | ServiceAccountek çêbike | `true` |
| `serviceAccount.annotations` | Annotations SA (mînak, IRSA ji bo AWS) | `{}` |
| `serviceAccount.name` | Navê SA jêbirin | `""` |

## Bikaranîna depoya S3 ya derve

Heke we berê RustFS, RustFS, an karûbarek din ê lihevhatî bi S3 heye, RustFS-ya built-in neçalak bikin:

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

## Lîsteya kontrola sarkuştina hilberînê

Berî ku bijîn:

- [ ] **Veşartî bi riya ESO an Sealed Secrets** — qet veşartiyan di pelên nirxan de nekin commit
- [ ] **Daxwaz û sînorkirinên çavkaniyan** li ser hemî belavkirinan hatine mîheng kirin
- [ ] **PodDisruptionBudget** mîheng kirî (`minAvailable: 1`) ji bo jêgerandinên bê-dem
- [ ] **NetworkPolicy** ku ingress ji kontrolerek ingress tenê ji bo poda app sînordar dike
- [ ] **Pelrêza root a tenê-xwendinê** li ser konteynera app (`securityContext.readOnlyRootFilesystem: true`)
- [ ] **Bikarhênerê ne-root** di konteynerê de (`securityContext.runAsNonRoot: true`)
- [ ] **PostgreSQL TLS** çalak e (`postgres.sslMode: require` di nirxan de)
- [ ] **RustFS TLS** an mTLS di nav app û RustFS de
- [ ] **cert-manager ClusterIssuer** ji bo nûvekirina otomatîk a Let's Encrypt mîheng kirî
- [ ] **Prometheus ServiceMonitor** çalak e û scraping dike
- [ ] **Pîşesaziyên jîngehê/amadehiyê** piştî belavkirinê hatine piştrast kirin
- [ ] **RBAC** — ServiceAccount bi mafên herî kêm
- [ ] **Polîtîkaya کششê wêneyê** hatiye danîn `IfNotPresent` (ne `Always`) ji bo belavkirinên pêşbînî
- [ ] **Sînorkirina rêjeya ingress** annotations hatine mîheng kirin ji bo kêmkirina istismarê

Mînaka NetworkPolicy:

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

## Firehbûn

Belavkirin stratejiya `RollingUpdate` bikar tîne ji bo nûvekirinên bê-dem. Replicas li gorî trafîka xwe fireh bikin:

```bash
kubectl scale deployment llamenos --replicas=3
```

An jî `app.replicas` di pelê nirxên xwe de mîheng bikin. Kilitên şêwirî yên PostgreSQL piştrast dikin ku yekbûna daneyê li ser hemî replicas domîne.

## Nûvekirin

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

Stratejiya `RollingUpdate` nûvekirinên bê-dem peyda dike.

## Jêbirin

```bash
helm uninstall llamenos
```

> **Not**: PersistentVolumeClaims ji hêla `helm uninstall` ve nayên jêbirin. Wan bi destan jê bibin heke hûn dixwazin hemî daneyê rakin:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## Çareserkirina Probleman

### Pod di CrashLoopBackOff de asê maye

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

Sedemên gelemperî: veşartiyên winda (`hmacSecret`, `serverWebSocketSecret`), PostgreSQL ne-gihîştbar, RustFS ne-amade.

### Pirsgirêkên girêdana danegehê

Piştrast bike ku PostgreSQL ji klastê ve gihîştbar e:

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- \
  psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Ingress naxebite

Piştrast bike ku kontrolerek ingress dixebite û çavkaniya Ingress navnîşanek heye:

```bash
kubectl get ingress llamenos
kubectl describe ingress llamenos
```

### Sertîfîka nehatiye dayîn

Statûya sertîfîkaya cert-manager kontrol bikin:

```bash
kubectl get certificate llamenos-tls
kubectl describe certificate llamenos-tls
kubectl get certificaterequest
kubectl describe certificaterequest
```

Sedemên gelemperî: DNS hîn nehatiye belav kirin, portên 80/443 ne vekirî ne, ClusterIssuer bi şaşî hatiye mîheng kirin.

## Gavên pêşerojê

- [Belavkirina Docker Compose](/docs/en/deploy/docker) — alternatîfa hêsantir a serverek yekane
- [Kurteya Xwe-Sazkirinê](/docs/en/deploy/self-hosting) — hemî vebijarkên belavkirinê bidin ber hev
- [Pêşkêşkerên Telefoniyê](/docs/en/deploy/providers/) — pêşkêşkerên deng mîheng bikin
