---
title: "Розгортання: Kubernetes (Helm)"
description: Розгорніть Llamenos у Kubernetes за допомогою офіційного Helm-чарту.
---

Цей посібник описує розгортання Llamenos у кластері Kubernetes за допомогою офіційного Helm-чарту. Чарт керує додатком, сховищем RustFS, релеєм WebSocket та опціональними службами signal-notifier/sip-bridge як окремими розгортаннями. Ви надаєте базу даних PostgreSQL.

## Передумови

- Кластер Kubernetes (v1.24+) — керований (EKS, GKE, AKS) або самостійний
- Екземпляр PostgreSQL 14+ (рекомендується керований RDS/Cloud SQL, або самостійний)
- [Helm](https://helm.sh/) v3.10+
- [kubectl](https://kubernetes.io/docs/tasks/tools/), налаштований для вашого кластера
- Контролер ingress (NGINX Ingress, Traefik тощо)
- cert-manager (опціонально, для автоматичних сертифікатів TLS)

## 1. Встановлення чарту

```bash
helm install llamenos deploy/helm/llamenos/ \
  --set secrets.postgresPassword=ВАШ_PG_ПАРОЛЬ \
  --set secrets.hmacSecret=ВАШ_HMAC_HEX \
  --set secrets.serverWebSocketSecret=ВАШ_NOSTR_HEX \
  --set postgres.host=ВАШ_PG_ХОСТ \
  --set RustFS.credentials.accessKey=ваш-ключ-доступу \
  --set RustFS.credentials.secretKey=ваш-секретний-ключ \
  --set ingress.hosts[0].host=hotline.yourdomain.com \
  --set ingress.tls[0].secretName=llamenos-tls \
  --set ingress.tls[0].hosts[0]=hotline.yourdomain.com
```

Або створіть файл `values-production.yaml` для відтворюваних розгортань:

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
    HOTLINE_NAME: "Ваша гаряча лінія"
    NODE_ENV: "production"

postgres:
  host: my-rds-instance.region.rds.amazonaws.com
  port: 5432
  database: llamenos
  user: llamenos
  poolSize: 10

secrets:
  postgresPassword: "ваш-надійний-пароль"
  hmacSecret: "64-hex-символи-hmac-підпис-ключ"
  serverWebSocketSecret: "64-hex-символи-WebSocket-ідентифікаційний-ключ"
  # Телефонія (принаймні один обов'язковий для голосу):
  # twilioAccountSid: ""
  # twilioAuthToken: ""
  # twilioPhoneNumber: ""

RustFS:
  enabled: true
  persistence:
    size: 50Gi
    storageClass: "gp3"
  credentials:
    accessKey: "ваш-ключ-доступу"
    secretKey: "ваш-секретний-ключ-змініть-мене"
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
  enabled: false   # встановіть true, щоб увімкнути сайдкар signal-notifier

sipBridge:
  enabled: false   # встановіть true, щоб увімкнути SIP міст (Asterisk/FreeSWITCH/Kamailio)
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

Потім встановіть:

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## 2. Перевірка розгортання

```bash
# Перевірте, чи працюють поді
kubectl get pods -l app.kubernetes.io/instance=llamenos

# Перевірте справність додатка
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# -> {"status":"ok"}
```

## 3. Налаштування DNS

Вкажіть ваш домен на зовнішню IP-адресу контролера ingress або балансувальника навантаження:

```bash
kubectl get ingress llamenos
```

## 4. Початкове налаштування

Відкрийте `https://hotline.yourdomain.com` у браузері та дотримуйтесь інструкцій майстра налаштування:

1. **Створіть обліковий запис адміністратора** — встановіть відображуване ім'я та PIN-код
2. **Назвіть свою гарячу лінію** — встановіть назву, яка відображатиметься в додатку
3. **Виберіть канали** — увімкніть голосовий зв'язок, SMS, WhatsApp, Signal та/або звіти
4. **Налаштуйте провайдерів** — введіть облікові дані для кожного увімкненого каналу
5. **Перевірте та завершіть**

## Інтеграція cert-manager

Якщо у вас встановлено [cert-manager](https://cert-manager.io/), налаштуйте кластерний емітент для автоматичного TLS:

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

Застосуйте його, потім посилайтеся на нього в анотаціях вашого ingress (вже включено у `values-production.yaml` вище):

```yaml
ingress:
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
```

cert-manager автоматично забезпечуватиме та оновлюватиме сертифікати TLS через Let's Encrypt.

## Зовнішній оператор секретів

Для продуктивного використання уникайте розміщення секретів безпосередньо в значеннях Helm. Використовуйте [External Secrets Operator](https://external-secrets.io/) для синхронізації секретів з вашого сховища секретів (AWS SSM, Vault, GCP Secret Manager тощо).

### 1. Створіть ExternalSecret

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
    name: my-secret-store   # ваш ClusterSecretStore або SecretStore
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

### 2. Посилання в значеннях Helm

```yaml
secrets:
  existingSecret: llamenos-secrets
```

Або створіть секрет вручну та посилайтеся на нього так само:

```bash
kubectl create secret generic llamenos-secrets \
  --from-literal=postgres-password=ваш_пароль \
  --from-literal=hmac-secret=ваш_hmac_hex \
  --from-literal=server-WebSocket-secret=ваш_WebSocket_hex \
  --from-literal=RustFS-access-key=ваш_ключ \
  --from-literal=RustFS-secret-key=ваш_секрет
```

## Моніторинг Prometheus

### ServiceMonitor

Якщо ви використовуєте [Prometheus Operator](https://prometheus-operator.dev/), увімкніть `ServiceMonitor` у ваших значеннях:

```yaml
monitoring:
  enabled: true
  serviceMonitor:
    namespace: monitoring    # простір імен, де встановлено Prometheus
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack
```

Чарт надає `/metrics` на службі додатка та налаштовує `ServiceMonitor` відповідно до вашого селектора Prometheus.

### Зонди справності

Чарт налаштовує зонди живості, готовності та запуску відносно `/health/live` та `/health/ready`:

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

### Журнали

```bash
kubectl logs -l app.kubernetes.io/instance=llamenos -c app -f
```

## Довідник конфігурації чарту

### Додаток

| Параметр | Опис | За замовчуванням |
|-----------|------|---------|
| `app.image.repository` | Образ контейнера | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | Тег образу | Chart appVersion |
| `app.image.pullPolicy` | Політика отримання | `IfNotPresent` |
| `app.port` | Порт додатка | `3000` |
| `app.replicas` | Репліки подів | `2` |
| `app.resources` | Запити та обмеження CPU/пам'яті | `{}` |
| `app.env` | Додаткові змінні середовища | `{}` |

### PostgreSQL

| Параметр | Опис | За замовчуванням |
|-----------|------|---------|
| `postgres.host` | Хост PostgreSQL (обов'язково) | `""` |
| `postgres.port` | Порт PostgreSQL | `5432` |
| `postgres.database` | Назва бази даних | `llamenos` |
| `postgres.user` | Користувач бази даних | `llamenos` |
| `postgres.poolSize` | Розмір пулу з'єднань | `10` |

### Секрети

| Параметр | Опис | За замовчуванням |
|-----------|------|---------|
| `secrets.postgresPassword` | Пароль PostgreSQL (обов'язково) | `""` |
| `secrets.hmacSecret` | Ключ підпису HMAC — 64 hex символи (обов'язково) | `""` |
| `secrets.serverWebSocketSecret` | Ідентифікаційний ключ сервера WebSocket — 64 hex символи (обов'язково) | `""` |
| `secrets.twilioAccountSid` | SID облікового запису Twilio | `""` |
| `secrets.twilioAuthToken` | Токен аутентифікації Twilio | `""` |
| `secrets.twilioPhoneNumber` | Номер телефону Twilio (E.164) | `""` |
| `secrets.existingSecret` | Використовувати існуючий Kubernetes Secret | `""` |

> **Порада**: Для продуктивного використання застосовуйте `secrets.existingSecret` з External Secrets Operator, Sealed Secrets або Vault.

### RustFS

| Параметр | Опис | За замовчуванням |
|-----------|------|---------|
| `RustFS.enabled` | Розгорнути RustFS | `true` |
| `RustFS.image.repository` | Образ RustFS | `RustFS/RustFS` |
| `RustFS.image.tag` | Тег RustFS | `latest` |
| `RustFS.persistence.size` | Розмір тому даних | `50Gi` |
| `RustFS.persistence.storageClass` | Клас сховища | `""` |
| `RustFS.credentials.accessKey` | Кореневий користувач RustFS (обов'язково) | `""` |
| `RustFS.credentials.secretKey` | Кореневий пароль RustFS (обов'язково) | `""` |
| `RustFS.resources` | Запити та обмеження CPU/пам'яті | `{}` |

### WebSocket relay (Релей WebSocket)

| Параметр | Опис | За замовчуванням |
|-----------|------|---------|
| `WebSocket relay.enabled` | Розгорнути релей WebSocket | `true` |
| `WebSocket relay.image.repository` | Образ релея WebSocket | `dockurr/WebSocket relay` |
| `WebSocket relay.image.tag` | Тег релея WebSocket | `latest` |
| `WebSocket relay.resources` | Запити та обмеження CPU/пам'яті | `{}` |

> Релей WebSocket є основною службою — події в реальному часі (дзвінки, сповіщення, стан хабу) потребують його. Залишайте `WebSocket relay.enabled: true`.

### signal-notifier

| Параметр | Опис | За замовчуванням |
|-----------|------|---------|
| `signalNotifier.enabled` | Розгорнути сайдкар signal-notifier | `false` |
| `signalNotifier.image.repository` | Образ signal-notifier | `ghcr.io/rhonda-rodododo/llamenos-signal-notifier` |
| `signalNotifier.resources` | Запити та обмеження CPU/пам'яті | `{}` |

### SIP міст

| Параметр | Опис | За замовчуванням |
|-----------|------|---------|
| `sipBridge.enabled` | Розгорнути sip-bridge | `false` |
| `sipBridge.pbxType` | Бекенд: `asterisk`, `freeswitch` або `kamailio` | `asterisk` |
| `sipBridge.resources` | Запити та обмеження CPU/пам'яті | `{}` |

### Моніторинг

| Параметр | Опис | За замовчуванням |
|-----------|------|---------|
| `monitoring.enabled` | Створити ServiceMonitor | `false` |
| `monitoring.serviceMonitor.interval` | Інтервал збору | `30s` |
| `monitoring.serviceMonitor.scrapeTimeout` | Тайм-аут збору | `10s` |
| `monitoring.serviceMonitor.namespace` | Простір імен для ServiceMonitor | Те саме, що й реліз |
| `monitoring.serviceMonitor.labels` | Додаткові мітки для селектора Prometheus | `{}` |

### Ingress

| Параметр | Опис | За замовчуванням |
|-----------|------|---------|
| `ingress.enabled` | Створити ресурс Ingress | `true` |
| `ingress.className` | Клас Ingress | `nginx` |
| `ingress.annotations` | Анотації Ingress | `{}` |
| `ingress.hosts` | Правила хостів | Див. values.yaml |
| `ingress.tls` | Конфігурація TLS | `[]` |

### Обліковий запис служби

| Параметр | Опис | За замовчуванням |
|-----------|------|---------|
| `serviceAccount.create` | Створити ServiceAccount | `true` |
| `serviceAccount.annotations` | Анотації SA (наприклад, IRSA для AWS) | `{}` |
| `serviceAccount.name` | Перевизначити ім'я SA | `""` |

## Використання зовнішнього S3-сумісного сховища

Якщо у вас уже є RustFS, RustFS або інша S3-сумісна служба, вимкніть вбудований RustFS:

```yaml
RustFS:
  enabled: false

app:
  env:
    STORAGE_ENDPOINT: "https://your-storage.example.com"
    STORAGE_ACCESS_KEY: "ваш-ключ"
    STORAGE_SECRET_KEY: "ваш-секрет"
    STORAGE_BUCKET: "llamenos"
```

## Контрольний список посилення безпеки для продуктивного середовища

Перед запуском у роботу:

- [ ] **Секрети через ESO або Sealed Secrets** — ніколи не зберігайте секрети у файлах значень
- [ ] **Запити та обмеження ресурсів** встановлені для всіх розгортань
- [ ] **PodDisruptionBudget** налаштований (`minAvailable: 1`) для безпростоєного дренування
- [ ] **NetworkPolicy**, що обмежує вхідний трафік до поду додатка лише від контролера ingress
- [ ] **Файлова система кореневого поду лише для читання** (`securityContext.readOnlyRootFilesystem: true`)
- [ ] **Не-root користувач** у контейнері (`securityContext.runAsNonRoot: true`)
- [ ] **PostgreSQL TLS** увімкнено (встановіть `postgres.sslMode: require` у значеннях)
- [ ] **RustFS TLS** або mTLS між додатком та RustFS
- [ ] **cert-manager ClusterIssuer** налаштований для автоматичного оновлення Let's Encrypt
- [ ] **Prometheus ServiceMonitor** увімкнено та здійснює збір даних
- [ ] **Зонди живості/готовності** перевірені після розгортання
- [ ] **RBAC** — ServiceAccount з мінімальними дозволами
- [ ] **Політика отримання образу** встановлена на `IfNotPresent` (не `Always`) для передбачуваних розгортань
- [ ] **Анотації обмеження швидкості Ingress** встановлені для пом'якшення зловживань

Приклад NetworkPolicy:

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

## Масштабування

Розгортання використовує стратегію `RollingUpdate` для безпростоєних оновлень. Масштабуйте репліки залежно від вашого трафіку:

```bash
kubectl scale deployment llamenos --replicas=3
```

Або встановіть `app.replicas` у вашому файлі значень. Блокування PostgreSQL advisory locks забезпечують узгодженість даних між репліками.

## Оновлення

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

Стратегія `RollingUpdate` забезпечує безпростоєні оновлення.

## Видалення

```bash
helm uninstall llamenos
```

> **Примітка**: PersistentVolumeClaims не видаляються командою `helm uninstall`. Видаліть їх вручну, якщо хочете видалити всі дані:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## Усунення несправностей

### Под застряг у CrashLoopBackOff

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

Поширені причини: відсутні секрети (`hmacSecret`, `serverWebSocketSecret`), PostgreSQL недоступний, RustFS не готовий.

### Помилки підключення до бази даних

Перевірте, чи PostgreSQL доступний з кластера:

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- \
  psql postgresql://llamenos:ПАРОЛЬ@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Ingress не працює

Перевірте, чи контролер ingress працює та чи ресурс Ingress має адресу:

```bash
kubectl get ingress llamenos
kubectl describe ingress llamenos
```

### Сертифікат не видано

Перевірте статус сертифіката cert-manager:

```bash
kubectl get certificate llamenos-tls
kubectl describe certificate llamenos-tls
kubectl get certificaterequest
kubectl describe certificaterequest
```

Поширені причини: DNS ще не поширено, порти 80/443 не відкрито, ClusterIssuer налаштовано неправильно.

## Наступні кроки

- [Розгортання Docker Compose](/docs/en/deploy/docker) — простіша альтернатива на одному сервері
- [Огляд самостійного хостингу](/docs/en/deploy/self-hosting) — порівняння варіантів розгортання
- [Телефонні провайдери](/docs/en/deploy/providers/) — налаштування голосових провайдерів
