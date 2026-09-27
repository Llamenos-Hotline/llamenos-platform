---
title: "استقرار: Kubernetes (Helm)"
description: Llámenos را با استفاده از نمودار رسمی Helm در Kubernetes مستقر کنید.
---

این راهنما استقرار Llámenos در یک خوشه Kubernetes با استفاده از نمودار رسمی Helm را پوشش می‌دهد. نمودار برنامه، ذخیره‌سازی RustFS، رله WebSocket و سرویس‌های اختیاری signal-notifier/sip-bridge را به عنوان استقرارهای جداگانه مدیریت می‌کند. شما یک پایگاه داده PostgreSQL ارائه می‌دهید.

## پیش‌نیازها

- یک خوشه Kubernetes (v1.24+) — مدیریت‌شده (EKS، GKE، AKS) یا میزبانی شخصی
- یک نمونه PostgreSQL 14+ (RDS/Cloud SQL مدیریت‌شده توصیه می‌شود، یا میزبانی شخصی)
- [Helm](https://helm.sh/) v3.10+
- [kubectl](https://kubernetes.io/docs/tasks/tools/) پیکربندی‌شده برای خوشه شما
- یک کنترل‌کننده ورودی (NGINX Ingress، Traefik و غیره)
- cert-manager (اختیاری، برای گواهینامه‌های TLS خودکار)

## ۱. نصب نمودار

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

یا یک فایل `values-production.yaml` برای استقرارهای قابل تکرار ایجاد کنید:

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
    HOTLINE_NAME: "خط تلفن شما"
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
  # تلفن (حداقل یکی برای صدا لازم است):
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
  enabled: false   # برای فعال‌سازی سایدکار signal-notifier true کنید

sipBridge:
  enabled: false   # برای فعال‌سازی پل SIP (Asterisk/FreeSWITCH/Kamailio) true کنید
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

سپس نصب کنید:

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## ۲. تأیید استقرار

```bash
# بررسی اجرای podها
kubectl get pods -l app.kubernetes.io/instance=llamenos

# بررسی سلامت برنامه
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# -> {"status":"ok"}
```

## ۳. پیکربندی DNS

دامنه خود را به IP خارجی کنترل‌کننده ورودی یا متعادل‌کننده بار指向 کنید:

```bash
kubectl get ingress llamenos
```

## ۴. راه‌اندازی اولیه

`https://hotline.yourdomain.com` را در مرورگر خود باز کنید و جادوگر راه‌اندازی را دنبال کنید:

1. **حساب مدیر خود را ایجاد کنید** — یک نام نمایشی و PIN خود را تنظیم کنید
2. **نام خط تلفن خود را تعیین کنید** — نام نمایشی که در برنامه نشان داده می‌شود را تنظیم کنید
3. **انتخاب کانال‌ها** — صدا، SMS، WhatsApp، Signal و/یا گزارش‌ها را فعال کنید
4. **پیکربندی ارائه‌دهندگان** — اعتبارنامه‌های هر کانال فعال را وارد کنید
5. **مرور و پایان**

## یکپارچه‌سازی cert-manager

اگر [cert-manager](https://cert-manager.io/) نصب شده است، صادرکننده خوشه را برای TLS خودکار پیکربندی کنید:

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

آن را اعمال کنید، سپس در حاشیه‌نویسی‌های ورودی خود به آن ارجاع دهید (قبلاً در `values-production.yaml` بالا گنجانده شده است):

```yaml
ingress:
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
```

cert-manager به طور خودکار گواهینامه‌های TLS را از طریق Let's Encrypt تأمین و تمدید می‌کند.

## External Secrets Operator

برای تولید، از قرار دادن مستقیم رازها در مقادیر Helm خودداری کنید. از [External Secrets Operator](https://external-secrets.io/) برای همگام‌سازی رازها از فروشگاه راز خود (AWS SSM، Vault، GCP Secret Manager و غیره) استفاده کنید.

### ۱. ایجاد یک ExternalSecret

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
    name: my-secret-store   # ClusterSecretStore یا SecretStore شما
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

### ۲. ارجاع در مقادیر Helm

```yaml
secrets:
  existingSecret: llamenos-secrets
```

از طرف دیگر، راز را به صورت دستی ایجاد کنید و به همان روش ارجاع دهید:

```bash
kubectl create secret generic llamenos-secrets \
  --from-literal=postgres-password=your_password \
  --from-literal=hmac-secret=your_hmac_hex \
  --from-literal=server-WebSocket-secret=your_WebSocket_hex \
  --from-literal=RustFS-access-key=your_key \
  --from-literal=RustFS-secret-key=your_secret
```

## نظارت Prometheus

### ServiceMonitor

اگر [Prometheus Operator](https://prometheus-operator.dev/) را اجرا می‌کنید، `ServiceMonitor` را در مقادیر خود فعال کنید:

```yaml
monitoring:
  enabled: true
  serviceMonitor:
    namespace: monitoring    # فضای نامی که Prometheus در آن نصب شده است
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack
```

نمودار `/metrics` را روی سرویس برنامه ارائه می‌دهد و `ServiceMonitor` را برای مطابقت با انتخابگر Prometheus شما پیکربندی می‌کند.

### بررسی‌های سلامت

نمودار بررسی‌های liveness، readiness و startup را در برابر `/health/live` و `/health/ready` پیکربندی می‌کند:

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

### لاگ‌ها

```bash
kubectl logs -l app.kubernetes.io/instance=llamenos -c app -f
```

## مرجع پیکربندی نمودار

### برنامه

| پارامتر | توضیحات | پیش‌فرض |
|---|---|---|
| `app.image.repository` | تصویر کانتینر | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | برچسب تصویر | Chart appVersion |
| `app.image.pullPolicy` | خط مشی دریافت | `IfNotPresent` |
| `app.port` | پورت برنامه | `3000` |
| `app.replicas` | تکرارهای Pod | `2` |
| `app.resources` | درخواست‌ها و محدودیت‌های CPU/حافظه | `{}` |
| `app.env` | متغیرهای محیطی اضافی | `{}` |

### PostgreSQL

| پارامتر | توضیحات | پیش‌فرض |
|---|---|---|
| `postgres.host` | نام میزبان PostgreSQL (اجباری) | `""` |
| `postgres.port` | پورت PostgreSQL | `5432` |
| `postgres.database` | نام پایگاه داده | `llamenos` |
| `postgres.user` | کاربر پایگاه داده | `llamenos` |
| `postgres.poolSize` | اندازه اتصال همزمان | `10` |

### رازها

| پارامتر | توضیحات | پیش‌فرض |
|---|---|---|
| `secrets.postgresPassword` | رمز عبور PostgreSQL (اجباری) | `""` |
| `secrets.hmacSecret` | کلید امضای HMAC — ۶۴ کاراکتر هگز (اجباری) | `""` |
| `secrets.serverWebSocketSecret` | کلید هویت WebSocket سرور — ۶۴ کاراکتر هگز (اجباری) | `""` |
| `secrets.twilioAccountSid` | Twilio Account SID | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token | `""` |
| `secrets.twilioPhoneNumber` | شماره تلفن Twilio (E.164) | `""` |
| `secrets.existingSecret` | استفاده از یک راز Kubernetes موجود | `""` |

> **نکته**: برای تولید، از `secrets.existingSecret` با External Secrets Operator، Sealed Secrets یا Vault استفاده کنید.

### RustFS

| پارامتر | توضیحات | پیش‌فرض |
|---|---|---|
| `RustFS.enabled` | استقرار RustFS | `true` |
| `RustFS.image.repository` | تصویر RustFS | `RustFS/RustFS` |
| `RustFS.image.tag` | برچسب RustFS | `latest` |
| `RustFS.persistence.size` | اندازه حجم داده | `50Gi` |
| `RustFS.persistence.storageClass` | کلاس ذخیره‌سازی | `""` |
| `RustFS.credentials.accessKey` | کاربر ریشه RustFS (اجباری) | `""` |
| `RustFS.credentials.secretKey` | رمز عبور ریشه RustFS (اجباری) | `""` |
| `RustFS.resources` | درخواست‌ها و محدودیت‌های CPU/حافظه | `{}` |

### رله WebSocket

| پارامتر | توضیحات | پیش‌فرض |
|---|---|---|
| `WebSocket relay.enabled` | استقرار رله WebSocket | `true` |
| `WebSocket relay.image.repository` | تصویر رله WebSocket | `dockurr/WebSocket relay` |
| `WebSocket relay.image.tag` | برچسب رله WebSocket | `latest` |
| `WebSocket relay.resources` | درخواست‌ها و محدودیت‌های CPU/حافظه | `{}` |

> رله WebSocket یک سرویس اصلی است — رویدادهای بلادرنگ (تماس‌ها، اعلان‌ها، وضعیت هاب) به آن نیاز دارند. `WebSocket relay.enabled: true` را حفظ کنید.

### signal-notifier

| پارامتر | توضیحات | پیش‌فرض |
|---|---|---|
| `signalNotifier.enabled` | استقرار سایدکار signal-notifier | `false` |
| `signalNotifier.image.repository` | تصویر signal-notifier | `ghcr.io/rhonda-rodododo/llamenos-signal-notifier` |
| `signalNotifier.resources` | درخواست‌ها و محدودیت‌های CPU/حافظه | `{}` |

### پل SIP

| پارامتر | توضیحات | پیش‌فرض |
|---|---|---|
| `sipBridge.enabled` | استقرار sip-bridge | `false` |
| `sipBridge.pbxType` | بک‌اند: `asterisk`، `freeswitch` یا `kamailio` | `asterisk` |
| `sipBridge.resources` | درخواست‌ها و محدودیت‌های CPU/حافظه | `{}` |

### نظارت

| پارامتر | توضیحات | پیش‌فرض |
|---|---|---|
| `monitoring.enabled` | ایجاد ServiceMonitor | `false` |
| `monitoring.serviceMonitor.interval` | فاصله خراش | `30s` |
| `monitoring.serviceMonitor.scrapeTimeout` | مهلت خراش | `10s` |
| `monitoring.serviceMonitor.namespace` | فضای نام برای ServiceMonitor | همان انتشار |
| `monitoring.serviceMonitor.labels` | برچسب‌های اضافی برای انتخابگر Prometheus | `{}` |

### ورودی

| پارامتر | توضیحات | پیش‌فرض |
|---|---|---|
| `ingress.enabled` | ایجاد منبع Ingress | `true` |
| `ingress.className` | کلاس ورودی | `nginx` |
| `ingress.annotations` | حاشیه‌نویسی‌های ورودی | `{}` |
| `ingress.hosts` | قوانین میزبان | مقادیر را در values.yaml ببینید |
| `ingress.tls` | پیکربندی TLS | `[]` |

### حساب سرویس

| پارامتر | توضیحات | پیش‌فرض |
|---|---|---|
| `serviceAccount.create` | ایجاد یک ServiceAccount | `true` |
| `serviceAccount.annotations` | حاشیه‌نویسی‌های SA (مثلاً IRSA برای AWS) | `{}` |
| `serviceAccount.name` | نادیده گرفتن نام SA | `""` |

## استفاده از فروشگاه سازگار با S3 خارجی

اگر از قبل RustFS، RustFS یا سرویس سازگار با S3 دیگری دارید، RustFS داخلی را غیرفعال کنید:

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

## چک‌لیست سخت‌افزاری تولید

قبل از راه‌اندازی:

- [ ] **رازها از طریق ESO یا Sealed Secrets** — هرگز رازها را به فایل‌های values commit نکنید
- [ ] **درخواست‌ها و محدودیت‌های منابع** روی همه استقرارها تنظیم شود
- [ ] **PodDisruptionBudget** پیکربندی شده (`minAvailable: 1`) برای تخلیه بدون وقفه
- [ ] **NetworkPolicy** محدود کننده ورود به pod برنامه فقط از کنترل‌کننده ورودی
- [ ] **سیستم فایل ریشه فقط خواندنی** روی کانتینر برنامه (`securityContext.readOnlyRootFilesystem: true`)
- [ ] **کاربر غیر ریشه** در کانتینر (`securityContext.runAsNonRoot: true`)
- [ ] **PostgreSQL TLS** فعال شده (در مقادیر `postgres.sslMode: require` تنظیم کنید)
- [ ] **RustFS TLS** یا mTLS بین برنامه و RustFS
- [ ] **ClusterIssuer cert-manager** برای تمدید خودکار Let's Encrypt پیکربندی شده
- [ ] **Prometheus ServiceMonitor** فعال و در حال خراش
- [ ] **بررسی‌های liveness/readiness** پس از استقرار تأیید شده
- [ ] **RBAC** — ServiceAccount با حداقل مجوزها
- [ ] **خط مشی دریافت تصویر** تنظیم به `IfNotPresent` (نه `Always`) برای استقرارهای قابل پیش‌بینی
- [ ] **حاشیه‌نویسی محدودیت نرخ ورودی** برای کاهش سوءاستفاده تنظیم شده

مثال NetworkPolicy:

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

## مقیاس‌سازی

استقرار از استراتژی `RollingUpdate` برای ارتقاهای بدون وقفه استفاده می‌کند. تکرارها را بر اساس ترافیک خود مقیاس کنید:

```bash
kubectl scale deployment llamenos --replicas=3
```

یا `app.replicas` را در فایل values خود تنظیم کنید. قفل‌های مشاوره PostgreSQL یکپارچگی داده را در سراسر تکرارها تضمین می‌کنند.

## ارتقا

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

استراتژی `RollingUpdate` ارتقاهای بدون وقفه را فراهم می‌کند.

## حذف نصب

```bash
helm uninstall llamenos
```

> **توجه**: PersistentVolumeClaims با `helm uninstall` حذف نمی‌شوند. اگر می‌خواهید همه داده‌ها را حذف کنید، آنها را به صورت دستی حذف کنید:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## عیب‌یابی

### Pod در CrashLoopBackOff گیر کرده است

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

علل رایج: رازهای گمشده (`hmacSecret`، `serverWebSocketSecret`)، PostgreSQL غیرقابل دسترسی، RustFS آماده نیست.

### خطاهای اتصال پایگاه داده

تأیید کنید PostgreSQL از خوشه قابل دسترسی است:

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- \
  psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### ورودی کار نمی‌کند

تأیید کنید کنترل‌کننده ورودی در حال اجرا است و منبع Ingress یک آدرس دارد:

```bash
kubectl get ingress llamenos
kubectl describe ingress llamenos
```

### گواهینامه صادر نشد

وضعیت گواهینامه cert-manager را بررسی کنید:

```bash
kubectl get certificate llamenos-tls
kubectl describe certificate llamenos-tls
kubectl get certificaterequest
kubectl describe certificaterequest
```

علل رایج: DNS هنوز منتشر نشده، پورت‌های ۸۰/۴۴۳ باز نیستند، ClusterIssuer اشتباه پیکربندی شده.

## مراحل بعدی

- [استقرار Docker Compose](/docs/en/deploy/docker) — جایگزین ساده‌تر تک سرور
- [نمای کلی میزبانی شخصی](/docs/en/deploy/self-hosting) — مقایسه گزینه‌های استقرار
- [ارائه‌دهندگان تلفنی](/docs/en/deploy/providers/) — پیکربندی ارائه‌دهندگان صوتی
