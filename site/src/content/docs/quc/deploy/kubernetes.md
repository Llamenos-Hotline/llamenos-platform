---
title: "Tik'otob': Kubernetes (Helm)"
description: Tikojo Llamenos pa Kubernetes ruk' ri oficial Helm wuj.
---

Ri ruk'amonik re' kuk'ut jawi' takotob' Llamenos pa jun Kubernetes cluster ruk' ri oficial Helm wuj. Ri wuj kuk'axaj ri runik'oj, RustFS yakb'al, WebSocket relay, chuqa' taq patan e tacha' signal-notifier/sip-bridge je' taq tik'otob' chik. Rat kayak jun PostgreSQL tanajib'al tzij.

## K'atz'ina taq jastaq

- Jun Kubernetes cluster (v1.24+) — e k'ayew (EKS, GKE, AKS) o tikojo tik'otob'
- Jun PostgreSQL 14+ k'ojik (RDS/Cloud SQL ya'on na'oj, o tikojo tik'otob')
- [Helm](https://helm.sh/) v3.10+
- [kubectl](https://kubernetes.io/docs/tasks/tools/) okisaxik che ri acluster
- Jun ingress controller (NGINX Ingress, Traefik, etc.)
- cert-manager (we nawaj, chike taq TLS certificado rub'anikil)

## 1. Tikojo ri wuj

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

O tikojo jun `values-production.yaml` wuj chike taq tik'otob' ri e kitzolin chik:

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
  # Telefonía (k'atz'in jun che ch'ab'äl):
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
  enabled: false   # taya' true chike tajaq ri signal-notifier sidecar

sipBridge:
  enabled: false   # taya' true chike tajaq ri SIP puerta (Asterisk/FreeSWITCH/Kamailio)
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

Tek'uri' tikojo:

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## 2. Tachajij ri tik'otob'

```bash
# Tachajij pods e k'as
kubectl get pods -l app.kubernetes.io/instance=llamenos

# Tachajij ri chajinik runik'oj
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# -> {"status":"ok"}
```

## 3. Tawokisaj DNS

Tawokisaj ri adominio cho ri ingress controller ruk' b'ey o load balancer:

```bash
kubectl get ingress llamenos
```

## 4. Nab'ej nik'oj

Tajaq `https://hotline.yourdomain.com` pa anuk'samaj chib'äl chuqa' tatz'ekelaj ri wokisaxik runik'oj:

1. **Tikojo ri ak'amalb'e cuenta** — taya' jun b'ij chuqa' ri aPIN
2. **Taya' jun b'ij che ri aruch'awib'al** — taya' ri b'ij ri tik'ut pa ri runik'oj
3. **Tacha' taq b'eyal** — tajaq Ch'ab'äl, SMS, WhatsApp, Signal, chuqa'/o Q'axeb'al Tzij
4. **Tawokisaj taq k'utunela'** — tak'oj retalib'al chi kij chi jujun b'eyal e tijaq
5. **Tak'utj chuqa' tak'oj**

## cert-manager k'ayb'al

We [cert-manager](https://cert-manager.io/) tik'otob', tawokisaj ri cluster issuer chike TLS rub'anikil:

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

Tak'oj, tek'uri' taya' retal pa ri ingress annotations (tik'oj chi kij ri `values-production.yaml`):

```yaml
ingress:
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
```

cert-manager kuya' TLS certificados ruk' Let's Encrypt.

## External Secrets Operator

Che ri producción, man tikoj ta etz'apwach taq tzij pa Helm values. Tach'ab'ej [External Secrets Operator](https://external-secrets.io/) chike kuk'ay etz'apwach taq tzij pa ri awokisaxik yakb'al (AWS SSM, Vault, GCP Secret Manager, etc.).

### 1. Tikojo jun ExternalSecret

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
    name: my-secret-store   # ri aClusterSecretStore o SecretStore
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

### 2. Taya' retal pa Helm values

```yaml
secrets:
  existingSecret: llamenos-secrets
```

O tikojo ri etz'apwach ruk' aq'ab' chuqa' taya' retal:

```bash
kubectl create secret generic llamenos-secrets \
  --from-literal=postgres-password=your_password \
  --from-literal=hmac-secret=your_hmac_hex \
  --from-literal=server-WebSocket-secret=your_WebSocket_hex \
  --from-literal=RustFS-access-key=your_key \
  --from-literal=RustFS-secret-key=your_secret
```

## Prometheus okisaxik

### ServiceMonitor

We katokisan ri [Prometheus Operator](https://prometheus-operator.dev/), tajaq ri `ServiceMonitor` pa ri avalues:

```yaml
monitoring:
  enabled: true
  serviceMonitor:
    namespace: monitoring    # namespace jawi' Prometheus tik'otob'
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack
```

Ri wuj kuk'ut `/metrics` pa ri app patan chuqa' kuk'oj ri `ServiceMonitor` chike k'ayew ruk' ri aPrometheus selector.

### Chajinik taq probe

Ri wuj kuk'oj liveness, readiness, chuqa' startup probes pa ruwi' `/health/live` chuqa' `/health/ready`:

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

### Taq wuj

```bash
kubectl logs -l app.kubernetes.io/instance=llamenos -c app -f
```

## Wuj nik'oj ruk'uts'ib'axik

### Runik'oj

| Parametro | Rutzijol | K'o wi |
|-----------|----------|--------|
| `app.image.repository` | Wuj k'ojik | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | Wuj retal | Wuj appVersion |
| `app.image.pullPolicy` | Pull runik'oj | `IfNotPresent` |
| `app.port` | Runik'oj puerto | `3000` |
| `app.replicas` | Pod replicas | `2` |
| `app.resources` | CPU/ch'obonic taq tz'ib'axik | `{}` |
| `app.env` | Chi kij taq okisaxel jaq | `{}` |

### PostgreSQL

| Parametro | Rutzijol | K'o wi |
|-----------|----------|--------|
| `postgres.host` | PostgreSQL hostname (k'atz'in) | `""` |
| `postgres.port` | PostgreSQL puerto | `5432` |
| `postgres.database` | Tanajib'al tzij b'ij | `llamenos` |
| `postgres.user` | Tanajib'al tzij okisan | `llamenos` |
| `postgres.poolSize` | K'ayb'al moloj nim raqän | `10` |

### Etz'apwach taq tzij

| Parametro | Rutzijol | K'o wi |
|-----------|----------|--------|
| `secrets.postgresPassword` | PostgreSQL etz'apwach tzij (k'atz'in) | `""` |
| `secrets.hmacSecret` | HMAC etz'apwach clave — 64 hex tzij (k'atz'in) | `""` |
| `secrets.serverWebSocketSecret` | Server WebSocket achi'el clave — 64 hex tzij (k'atz'in) | `""` |
| `secrets.twilioAccountSid` | Twilio Cuenta SID | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token | `""` |
| `secrets.twilioPhoneNumber` | Twilio rajilab'al teléfono (E.164) | `""` |
| `secrets.existingSecret` | Tacha' jun k'ojik Kubernetes Secret | `""` |

> **Na'oj**: Che ri producción, tach'ab'ej `secrets.existingSecret` ruk' External Secrets Operator, Sealed Secrets, o Vault.

### RustFS

| Parametro | Rutzijol | K'o wi |
|-----------|----------|--------|
| `RustFS.enabled` | Tikojo RustFS | `true` |
| `RustFS.image.repository` | RustFS wuj | `RustFS/RustFS` |
| `RustFS.image.tag` | RustFS retal | `latest` |
| `RustFS.persistence.size` | Tzij raqän | `50Gi` |
| `RustFS.persistence.storageClass` | Yakb'al wokisaxik | `""` |
| `RustFS.credentials.accessKey` | RustFS root okisan (k'atz'in) | `""` |
| `RustFS.credentials.secretKey` | RustFS root etz'apwach tzij (k'atz'in) | `""` |
| `RustFS.resources` | CPU/ch'obonic taq tz'ib'axik | `{}` |

### WebSocket relay

| Parametro | Rutzijol | K'o wi |
|-----------|----------|--------|
| `WebSocket relay.enabled` | Tikojo WebSocket relay | `true` |
| `WebSocket relay.image.repository` | WebSocket relay wuj | `dockurr/WebSocket relay` |
| `WebSocket relay.image.tag` | WebSocket relay retal | `latest` |
| `WebSocket relay.resources` | CPU/ch'obonic taq tz'ib'axik | `{}` |

> WebSocket relay jun core patan — taq k'ak' tzij (siponik, taq tzijol, hub rajal) k'atz'in. Tachajij `WebSocket relay.enabled: true`.

### signal-notifier

| Parametro | Rutzijol | K'o wi |
|-----------|----------|--------|
| `signalNotifier.enabled` | Tikojo signal-notifier sidecar | `false` |
| `signalNotifier.image.repository` | signal-notifier wuj | `ghcr.io/rhonda-rodododo/llamenos-signal-notifier` |
| `signalNotifier.resources` | CPU/ch'obonic taq tz'ib'axik | `{}` |

### SIP puerta

| Parametro | Rutzijol | K'o wi |
|-----------|----------|--------|
| `sipBridge.enabled` | Tikojo sip-bridge | `false` |
| `sipBridge.pbxType` | Backend: `asterisk`, `freeswitch`, o `kamailio` | `asterisk` |
| `sipBridge.resources` | CPU/ch'obonic taq tz'ib'axik | `{}` |

### Okisaxik

| Parametro | Rutzijol | K'o wi |
|-----------|----------|--------|
| `monitoring.enabled` | Tikojo ServiceMonitor | `false` |
| `monitoring.serviceMonitor.interval` | Q'otij k'ulik | `30s` |
| `monitoring.serviceMonitor.scrapeTimeout` | Q'otij chupik | `10s` |
| `monitoring.serviceMonitor.namespace` | ServiceMonitor namespace | Junam ruk' release |
| `monitoring.serviceMonitor.labels` | Chi kij taq retal che Prometheus selector | `{}` |

### Ingress

| Parametro | Rutzijol | K'o wi |
|-----------|----------|--------|
| `ingress.enabled` | Tikojo Ingress | `true` |
| `ingress.className` | Ingress wokisaxik | `nginx` |
| `ingress.annotations` | Ingress retal taq tzij | `{}` |
| `ingress.hosts` | Host taq runik'oj | Tak'ut values.yaml |
| `ingress.tls` | TLS nik'oj | `[]` |

### Service account

| Parametro | Rutzijol | K'o wi |
|-----------|----------|--------|
| `serviceAccount.create` | Tikojo jun ServiceAccount | `true` |
| `serviceAccount.annotations` | SA retal taq tzij (je' IRSA che AWS) | `{}` |
| `serviceAccount.name` | Tatz'ekelaj SA b'ij | `""` |

## Tacha' jun S3-compatible wokisaxik

We k'oj chik RustFS o jun S3-compatible patan, tachup ri RustFS:

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

## Producción chojmirik ch'ob'onik

Chi k'a chwech tatik'otob':

- [ ] **Etz'apwach taq tzij ruk' ESO o Sealed Secrets** — majun etz'apwach taq tzij pa values wuj
- [ ] **Okisaxel taq tz'ib'axik** e tik'oj pa ronojel taq tik'otob'
- [ ] **PodDisruptionBudget** tik'oj (`minAvailable: 1`) chike majun chupik
- [ ] **NetworkPolicy** ri kuchup ri okisan xwi pa ingress controller
- [ ] **Xwi k'utik root filesystem** pa app container (`securityContext.readOnlyRootFilesystem: true`)
- [ ] **Majun root okisan** pa container (`securityContext.runAsNonRoot: true`)
- [ ] **PostgreSQL TLS** tijaq (taya' `postgres.sslMode: require` pa values)
- [ ] **RustFS TLS** o mTLS chikij app chuqa' RustFS
- [ ] **cert-manager ClusterIssuer** tik'oj che Let's Encrypt rub'anikil
- [ ] **Prometheus ServiceMonitor** tijaq chuqa' kuk'ok
- [ ] **Liveness/readiness probes** tachajij chrij tik'otob'
- [ ] **RBAC** — ServiceAccount ruk' ch'in taq b'ey
- [ ] **Image pull policy** tik'oj pa `IfNotPresent` (man `Always` ta)

Je' NetworkPolicy:

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

Ri tik'otob' kuk'ay `RollingUpdate` strategia chike majun chupik. Tayala' replicas pa ruwi' ri tráfico:

```bash
kubectl scale deployment llamenos --replicas=3
```

O taya' `app.replicas` pa ri avalues wuj. PostgreSQL advisory locks kek'ayew chi ri tzij k'oj pa ronojel replicas.

## K'ak' rub'anikil

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

Ri `RollingUpdate` strategia kuk'ay majun chupik.

## Tiyuj

```bash
helm uninstall llamenos
```

> **Na'oj**: PersistentVolumeClaims man e k'ay ta ruk' `helm uninstall`. Tiyuj ruk' aq'ab' we nawaj tiyuj ronojel:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## Ruchojmil taq jastaq

### Pod tik'otob' pa CrashLoopBackOff

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

Ajk'ay: etz'apwach taq tzij e ajaw (`hmacSecret`, `serverWebSocketSecret`), PostgreSQL man k'ayew ta, RustFS man k'oj ta.

### Database k'ayb'al taq ch'ayik

Tachajij we PostgreSQL k'ayew pa ri cluster:

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- \
  psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Ingress man tik'ayew ta

Tachajij we ri ingress controller k'as chuqa' ri Ingress k'oj jun b'ey:

```bash
kubectl get ingress llamenos
kubectl describe ingress llamenos
```

### Certificado man ya'on ta

Tachajij ri cert-manager certificate rajal:

```bash
kubectl get certificate llamenos-tls
kubectl describe certificate llamenos-tls
kubectl get certificaterequest
kubectl describe certificaterequest
```

Ajk'ay: DNS man k'ayew ta, puertos 80/443 man jaq ta, ClusterIssuer man utz ta tik'oj.

## Chi k'aj taq b'ey

- [Docker Compose Tik'otob'](/docs/en/deploy/docker) — ch'in jun servidor
- [Tikojo Tik'otob' Ruk'uts'ib'axik](/docs/en/deploy/self-hosting) — tatz'eqelaj taq wokisaxik tik'otob'
- [K'utunela' Telefonía](/docs/en/deploy/providers/) — tawokisaj k'utunel ch'ab'äl
