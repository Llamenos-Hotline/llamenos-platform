---
title: "Dağıtım: Kubernetes (Helm)"
description: Resmi Helm grafiğini kullanarak Llamenos'u Kubernetes'e dağıtın.
---

Bu kılavuz, resmi Helm grafiğini kullanarak Llamenos'u bir Kubernetes kümesine dağıtmayı kapsar. Grafik, uygulamayı, RustFS depolamayı, WebSocket rölesi WebSocket rölesi ve isteğe bağlı signal-notifier/sip-bridge hizmetlerini ayrı dağıtımlar olarak yönetir. Bir PostgreSQL veritabanı sağlarsınız.

## Ön koşullar

- Bir Kubernetes kümesi (v1.24+) — yönetilen (EKS, GKE, AKS) veya kendi sunucunuzda
- Bir PostgreSQL 14+ örneği (yönetilen RDS/Cloud SQL önerilir veya kendi sunucunuzda)
- [Helm](https://helm.sh/) v3.10+
- Kümeniz için yapılandırılmış [kubectl](https://kubernetes.io/docs/tasks/tools/)
- Bir giriş denetleyicisi (NGINX Ingress, Traefik, vb.)
- cert-manager (isteğe bağlı, otomatik TLS sertifikaları için)

## 1. Grafiği kurun

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

Veya tekrarlanabilir dağıtımlar için bir `values-production.yaml` dosyası oluşturun:

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
  # Telefon (ses için en az biri gerekli):
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
  enabled: false   # signal-notifier yan hizmetini etkinleştirmek için true yapın

sipBridge:
  enabled: false   # SIP köprüsünü etkinleştirmek için true yapın (Asterisk/FreeSWITCH/Kamailio)
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

Ardından kurun:

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## 2. Dağıtımı doğrulayın

```bash
# Pod'ların çalıştığını kontrol edin
kubectl get pods -l app.kubernetes.io/instance=llamenos

# Uygulama sağlığını kontrol edin
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# -> {"status":"ok"}
```

## 3. DNS'i yapılandırın

Alan adınızı giriş denetleyicisinin harici IP'sine veya yük dengeleyicisine yönlendirin:

```bash
kubectl get ingress llamenos
```

## 4. İlk kurulum

Tarayıcınızda `https://hotline.yourdomain.com` adresini açın ve kurulum sihirbazını takip edin:

1. **Yönetici hesabınızı oluşturun** — görünen bir ad ve PIN'inizi ayarlayın
2. **Yardım hattınıza bir ad verin** — uygulamada gösterilen görünen adı ayarlayın
3. **Kanalları seçin** — Ses, SMS, WhatsApp, Signal ve/veya Raporları etkinleştirin
4. **Sağlayıcıları yapılandırın** — her etkin kanal için kimlik bilgilerini girin
5. **Gözden geçirin ve bitirin**

## cert-manager entegrasyonu

[cert-manager](https://cert-manager.io/) yüklüyse, otomatik TLS için küme verenini yapılandırın:

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

Uygulayın, ardından giriş ek açıklamalarında buna atıfta bulunun (yukarıdaki `values-production.yaml`'da zaten dahil):

```yaml
ingress:
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
```

cert-manager, Let's Encrypt aracılığıyla TLS sertifikalarını otomatik olarak sağlayacak ve yenileyecektir.

## Harici Sırlar Operatörü

Üretim için, sırları doğrudan Helm değerlerine koymaktan kaçının. Sırlarınızı gizli mağazanızdan (AWS SSM, Vault, GCP Secret Manager, vb.) senkronize etmek için [Harici Sırlar Operatörü](https://external-secrets.io/) kullanın.

### 1. Bir ExternalSecret oluşturun

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
    name: my-secret-store   # ClusterSecretStore veya SecretStore'niz
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

### 2. Helm değerlerinde atıfta bulunun

```yaml
secrets:
  existingSecret: llamenos-secrets
```

Alternatif olarak, sırrı manuel olarak oluşturun ve aynı şekilde atıfta bulunun:

```bash
kubectl create secret generic llamenos-secrets \
  --from-literal=postgres-password=your_password \
  --from-literal=hmac-secret=your_hmac_hex \
  --from-literal=server-WebSocket-secret=your_WebSocket_hex \
  --from-literal=RustFS-access-key=your_key \
  --from-literal=RustFS-secret-key=your_secret
```

## Prometheus izleme

### ServiceMonitor

[Prometheus Operatörü](https://prometheus-operator.dev/) çalıştırıyorsanız, değerlerinizde `ServiceMonitor`'ı etkinleştirin:

```yaml
monitoring:
  enabled: true
  serviceMonitor:
    namespace: monitoring    # Prometheus'ın yüklendiği ad alanı
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack
```

Grafik, `/metrics` uç noktasını uygulama hizmetinde sunar ve Prometheus seçicinizle eşleşecek şekilde `ServiceMonitor`'ı yapılandırır.

### Sağlık prob'ları

Grafik, `/health/live` ve `/health/ready` karşı canlılık, hazırlık ve başlangıç prob'larını yapılandırır:

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

### Günlükler

```bash
kubectl logs -l app.kubernetes.io/instance=llamenos -c app -f
```

## Grafik yapılandırma referansı

### Uygulama

| Parametre | Açıklama | Varsayılan |
|-----------|-------------|---------|
| `app.image.repository` | Konteyner imajı | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | İmaj etiketi | Grafik appVersion |
| `app.image.pullPolicy` | Çekme politikası | `IfNotPresent` |
| `app.port` | Uygulama bağlantı noktası | `3000` |
| `app.replicas` | Pod kopyaları | `2` |
| `app.resources` | CPU/bellek istekleri ve limitleri | `{}` |
| `app.env` | Ek ortam değişkenleri | `{}` |

### PostgreSQL

| Parametre | Açıklama | Varsayılan |
|-----------|-------------|---------|
| `postgres.host` | PostgreSQL ana bilgisayar adı (gerekli) | `""` |
| `postgres.port` | PostgreSQL bağlantı noktası | `5432` |
| `postgres.database` | Veritabanı adı | `llamenos` |
| `postgres.user` | Veritabanı kullanıcısı | `llamenos` |
| `postgres.poolSize` | Bağlantı havuzu boyutu | `10` |

### Sırlar

| Parametre | Açıklama | Varsayılan |
|-----------|-------------|---------|
| `secrets.postgresPassword` | PostgreSQL parolası (gerekli) | `""` |
| `secrets.hmacSecret` | HMAC imzalama anahtarı — 64 onaltılık karakter (gerekli) | `""` |
| `secrets.serverWebSocketSecret` | Sunucu WebSocket kimlik anahtarı — 64 onaltılık karakter (gerekli) | `""` |
| `secrets.twilioAccountSid` | Twilio Hesap SID'si | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token'ı | `""` |
| `secrets.twilioPhoneNumber` | Twilio telefon numarası (E.164) | `""` |
| `secrets.existingSecret` | Mevcut bir Kubernetes Secret kullan | `""` |

> **İpucu**: Üretim için, Harici Sırlar Operatörü, Sealed Secrets veya Vault ile `secrets.existingSecret` kullanın.

### RustFS

| Parametre | Açıklama | Varsayılan |
|-----------|-------------|---------|
| `RustFS.enabled` | RustFS'yi dağıt | `true` |
| `RustFS.image.repository` | RustFS imajı | `RustFS/RustFS` |
| `RustFS.image.tag` | RustFS etiketi | `latest` |
| `RustFS.persistence.size` | Veri birimi boyutu | `50Gi` |
| `RustFS.persistence.storageClass` | Depolama sınıfı | `""` |
| `RustFS.credentials.accessKey` | RustFS kök kullanıcı (gerekli) | `""` |
| `RustFS.credentials.secretKey` | RustFS kök parolası (gerekli) | `""` |
| `RustFS.resources` | CPU/bellek istekleri ve limitleri | `{}` |

### WebSocket rölesi

| Parametre | Açıklama | Varsayılan |
|-----------|-------------|---------|
| `WebSocket relay.enabled` | WebSocket rölesini dağıt | `true` |
| `WebSocket relay.image.repository` | WebSocket rölesi imajı | `dockurr/WebSocket relay` |
| `WebSocket relay.image.tag` | WebSocket rölesi etiketi | `latest` |
| `WebSocket relay.resources` | CPU/bellek istekleri ve limitleri | `{}` |

> WebSocket rölesi bir temel hizmettir — gerçek zamanlı olaylar (çağrılar, bildirimler, hub durumu) bunu gerektirir. `WebSocket relay.enabled: true` tutun.

### signal-notifier

| Parametre | Açıklama | Varsayılan |
|-----------|-------------|---------|
| `signalNotifier.enabled` | signal-notifier yan hizmetini dağıt | `false` |
| `signalNotifier.image.repository` | signal-notifier imajı | `ghcr.io/rhonda-rodododo/llamenos-signal-notifier` |
| `signalNotifier.resources` | CPU/bellek istekleri ve limitleri | `{}` |

### SIP köprüsü

| Parametre | Açıklama | Varsayılan |
|-----------|-------------|---------|
| `sipBridge.enabled` | sip-bridge'i dağıt | `false` |
| `sipBridge.pbxType` | Arka uç: `asterisk`, `freeswitch` veya `kamailio` | `asterisk` |
| `sipBridge.resources` | CPU/bellek istekleri ve limitleri | `{}` |

### İzleme

| Parametre | Açıklama | Varsayılan |
|-----------|-------------|---------|
| `monitoring.enabled` | ServiceMonitor oluştur | `false` |
| `monitoring.serviceMonitor.interval` | Kazıma aralığı | `30s` |
| `monitoring.serviceMonitor.scrapeTimeout` | Kazıma zaman aşımı | `10s` |
| `monitoring.serviceMonitor.namespace` | ServiceMonitor için ad alanı | Sürümle aynı |
| `monitoring.serviceMonitor.labels` | Prometheus seçici için ek etiketler | `{}` |

### Giriş

| Parametre | Açıklama | Varsayılan |
|-----------|-------------|---------|
| `ingress.enabled` | Giriş kaynağı oluştur | `true` |
| `ingress.className` | Giriş sınıfı | `nginx` |
| `ingress.annotations` | Giriş ek açıklamaları | `{}` |
| `ingress.hosts` | Ana bilgisayar kuralları | values.yaml'a bakın |
| `ingress.tls` | TLS yapılandırması | `[]` |

### Hizmet hesabı

| Parametre | Açıklama | Varsayılan |
|-----------|-------------|---------|
| `serviceAccount.create` | Bir ServiceAccount oluştur | `true` |
| `serviceAccount.annotations` | SA ek açıklamaları (örn. AWS için IRSA) | `{}` |
| `serviceAccount.name` | SA adını geçersiz kıl | `""` |

## Harici bir S3-uyumlu mağaza kullanma

Zaten RustFS, RustFS veya başka bir S3-uyumlu hizmetiniz varsa, yerleşik RustFS'yi devre dışı bırakın:

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

## Üretim sertleştirme kontrol listesi

Canlıya geçmeden önce:

- [ ] **ESO veya Sealed Secrets ile sırlar** — sırları asla değer dosyalarına taahhüt etmeyin
- [ ] Tüm dağıtımlarda **kaynak istekleri ve limitleri** ayarlandı
- [ ] Sıfır kesinti süreli boşaltmalar için **PodDisruptionBudget** yapılandırıldı (`minAvailable: 1`)
- [ ] Giriş denetleyicisinden uygulama pod'una **NetworkPolicy** ile erişimi kısıtlama
- [ ] Uygulama konteynerinde **salt okunur kök dosya sistemi** (`securityContext.readOnlyRootFilesystem: true`)
- [ ] Konteynerde **kök olmayan kullanıcı** (`securityContext.runAsNonRoot: true`)
- [ ] **PostgreSQL TLS** etkinleştirildi (değerlerde `postgres.sslMode: require` ayarlandı)
- [ ] Uygulama ve RustFS arasında **RustFS TLS** veya mTLS
- [ ] Otomatik Let's Encrypt yenileme için **cert-manager ClusterIssuer** yapılandırıldı
- [ ] **Prometheus ServiceMonitor** etkinleştirildi ve kazıyor
- [ ] Dağıtımdan sonra **Canlılık/hazırlık prob'ları** doğrulandı
- [ ] **RBAC** — minimum izinlerle ServiceAccount
- [ ] Tahmin edilebilir dağıtımlar için **İmaj çekme politikası** `IfNotPresent` ( `Always` değil) olarak ayarlandı
- [ ] **Giriş hız sınırlama** ek açıklamaları kötüye kullanımı azaltmak için ayarlandı

Örnek NetworkPolicy:

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

## Ölçeklendirme

Dağıtım, sıfır kesinti süreli yükseltmeler için `RollingUpdate` stratejisi kullanır. Trafik miktarınıza göre kopyaları ölçeklendirin:

```bash
kubectl scale deployment llamenos --replicas=3
```

Veya değerler dosyanızda `app.replicas` ayarlayın. PostgreSQL danışman kilitleri, kopyalar arasında veri tutarlılığını sağlar.

## Yükseltme

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

`RollingUpdate` stratejisi sıfır kesinti süreli yükseltmeler sağlar.

## Kaldırma

```bash
helm uninstall llamenos
```

> **Not**: `helm uninstall` tarafından PersistentVolumeClaims silinmez. Tüm verileri kaldırmak istiyorsanız bunları manuel olarak silin:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## Sorun giderme

### Pod CrashLoopBackOff'ta takılı kaldı

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

Yaygın nedenler: eksik sırlar (`hmacSecret`, `serverWebSocketSecret`), PostgreSQL'e erişilemiyor, RustFS hazır değil.

### Veritabanı bağlantı hataları

PostgreSQL'in kümeden erişilebilir olduğunu doğrulayın:

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- \
  psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Giriş çalışmıyor

Giriş denetleyicisinin çalıştığını ve Giriş kaynağının bir adresi olduğunu doğrulayın:

```bash
kubectl get ingress llamenos
kubectl describe ingress llamenos
```

### Sertifika verilmedi

cert-manager sertifika durumunu kontrol edin:

```bash
kubectl get certificate llamenos-tls
kubectl describe certificate llamenos-tls
kubectl get certificaterequest
kubectl describe certificaterequest
```

Yaygın nedenler: DNS henüz yayılmadı, 80/443 numaralı bağlantı noktaları açık değil, ClusterIssuer yanlış yapılandırıldı.

## Sonraki adımlar

- [Docker Compose Dağıtımı](/docs/en/deploy/docker) — daha basit tek sunucu alternatifi
- [Kendi Sunucunuzda Barındırma Genel Bakış](/docs/en/deploy/self-hosting) — dağıtım seçeneklerini karşılaştırın
- [Telefon Sağlayıcıları](/docs/en/deploy/providers/) — ses sağlayıcılarını yapılandırın
