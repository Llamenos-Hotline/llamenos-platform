---
title: "Развёртывание: Kubernetes (Helm)"
description: Развёртывание Llamenos в Kubernetes с помощью официального Helm-чарта.
---

Это руководство охватывает развёртывание Llamenos в кластере Kubernetes с помощью официального Helm-чарта. Чарт управляет приложением и опциональными сервисами RustFS/Whisper как отдельными развёртываниями. База данных PostgreSQL предоставляется вами.

## Предварительные требования

- Кластер Kubernetes (v1.24+) — управляемый (EKS, GKE, AKS) или самостоятельно размещённый
- Экземпляр PostgreSQL 14+ (рекомендуется управляемый RDS/Cloud SQL или самостоятельно размещённый)
- [Helm](https://helm.sh/) v3.10+
- [kubectl](https://kubernetes.io/docs/tasks/tools/), настроенный для вашего кластера
- Контроллер Ingress (NGINX Ingress, Traefik и т. д.)
- cert-manager (опционально, для автоматических TLS-сертификатов)
- [Bun](https://bun.sh/), установленный локально (для генерации пары ключей администратора)


## 2. Установка чарта

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

Или создайте файл `values-production.yaml` для воспроизводимых развёртываний:

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

Затем выполните установку:

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## 3. Проверка развёртывания

```bash
# Check pods are running
kubectl get pods -l app.kubernetes.io/instance=llamenos

# Check the app health
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# → {"status":"ok"}
```

## 4. Настройка DNS

Укажите ваш домен на внешний IP или балансировщик нагрузки контроллера Ingress:

```bash
kubectl get ingress llamenos
```

## 5. Первый вход и настройка

Откройте `https://hotline.yourdomain.com` в браузере. Войдите с nsec администратора и завершите мастер настройки.

## Справочник конфигурации чарта

### Приложение

| Параметр | Описание | По умолчанию |
|-----------|-------------|---------|
| `app.image.repository` | Образ контейнера | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | Тег образа | Версия чарта |
| `app.port` | Порт приложения | `3000` |
| `app.replicas` | Реплики Pod | `2` |
| `app.resources` | Запросы и лимиты CPU/памяти | `{}` |
| `app.env` | Дополнительные переменные окружения | `{}` |

### PostgreSQL

| Параметр | Описание | По умолчанию |
|-----------|-------------|---------|
| `postgres.host` | Имя хоста PostgreSQL (обязательно) | `""` |
| `postgres.port` | Порт PostgreSQL | `5432` |
| `postgres.database` | Имя базы данных | `llamenos` |
| `postgres.user` | Пользователь базы данных | `llamenos` |
| `postgres.poolSize` | Размер пула соединений | `10` |

### Секреты

| Параметр | Описание | По умолчанию |
|-----------|-------------|---------|
| `secrets.hmacSecret` | HMAC signing key — 64 hex chars (required) | `""` |
| `secrets.serverWebSocketSecret` | Server WebSocket identity key — 64 hex chars (required) | `""` |
| `secrets.postgresPassword` | Пароль PostgreSQL (обязательно) | `""` |
| `secrets.twilioAccountSid` | Twilio Account SID | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token | `""` |
| `secrets.twilioPhoneNumber` | Номер телефона Twilio (E.164) | `""` |
| `secrets.existingSecret` | Использовать существующий K8s Secret | `""` |

> **Совет**: Для производственной среды используйте `secrets.existingSecret` для ссылки на Secret, управляемый External Secrets Operator, Sealed Secrets или Vault.

### RustFS

| Параметр | Описание | По умолчанию |
|-----------|-------------|---------|
| `rustfs.enabled` | Развернуть RustFS | `true` |
| `rustfs.image.repository` | Образ RustFS | `rustfs/rustfs` |
| `rustfs.image.tag` | Тег RustFS | `RELEASE.2025-01-20T14-49-07Z` |
| `rustfs.persistence.size` | Том данных RustFS | `50Gi` |
| `rustfs.persistence.storageClass` | Класс хранилища | `""` |
| `rustfs.credentials.accessKey` | Корневой пользователь RustFS | `""` (обязательно) |
| `rustfs.credentials.secretKey` | Корневой пароль RustFS | `""` (обязательно) |
| `rustfs.resources` | Запросы и лимиты CPU/памяти | `{}` |

### Транскрипция Whisper

| Параметр | Описание | По умолчанию |
|-----------|-------------|---------|
| `whisper.enabled` | Развернуть Whisper | `false` |
| `whisper.image.repository` | Образ Whisper | `fedirz/faster-whisper-server` |
| `whisper.image.tag` | Тег Whisper | `0.4.1` |
| `whisper.model` | Название модели Whisper | `Systran/faster-whisper-base` |
| `whisper.device` | Устройство: `cpu` или `cuda` | `cpu` |
| `whisper.resources` | Запросы и лимиты CPU/памяти | `{}` |

### Ingress

| Параметр | Описание | По умолчанию |
|-----------|-------------|---------|
| `ingress.enabled` | Создать ресурс Ingress | `true` |
| `ingress.className` | Класс Ingress | `nginx` |
| `ingress.annotations` | Аннотации Ingress | `{}` |
| `ingress.hosts` | Правила хостов | См. values.yaml |
| `ingress.tls` | Конфигурация TLS | `[]` |

### Сервисный аккаунт

| Параметр | Описание | По умолчанию |
|-----------|-------------|---------|
| `serviceAccount.create` | Создать ServiceAccount | `true` |
| `serviceAccount.annotations` | Аннотации SA (например, IRSA) | `{}` |
| `serviceAccount.name` | Переопределить имя SA | `""` |

## Использование внешних секретов

Для производственной среды избегайте хранения секретов напрямую в значениях Helm. Вместо этого создайте Secret отдельно и ссылайтесь на него:

```yaml
# values-production.yaml
secrets:
  existingSecret: llamenos-secrets
```

Создайте Secret с предпочтительным инструментом:

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

## Использование внешнего RustFS или S3

Если у вас уже есть RustFS или S3-совместимый сервис, отключите встроенный RustFS и передайте эндпоинт:

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

## Транскрипция на GPU

Для транскрипции Whisper с ускорением GPU на видеокартах NVIDIA:

```yaml
whisper:
  enabled: true
  device: "cuda"
  model: "Systran/faster-whisper-large-v3"
  resources:
    limits:
      nvidia.com/gpu: 1
```

Убедитесь, что в вашем кластере установлен [плагин устройств NVIDIA](https://github.com/NVIDIA/k8s-device-plugin).

## Масштабирование

Развёртывание использует стратегию `RollingUpdate` для обновлений без простоя. Масштабируйте реплики в зависимости от трафика:

```bash
kubectl scale deployment llamenos --replicas=3
```

Или задайте `app.replicas` в файле values. Консультативные блокировки PostgreSQL обеспечивают согласованность данных между репликами.


## Мониторинг

### Проверки состояния

Чарт настраивает пробы liveness, readiness и startup для `/api/health`:

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

### Журналы

```bash
kubectl logs -l app.kubernetes.io/instance=llamenos -c app -f
```

## Обновление

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

Стратегия `RollingUpdate` обеспечивает обновления без простоя.

## Удаление

```bash
helm uninstall llamenos
```

> **Примечание**: PersistentVolumeClaims не удаляются при `helm uninstall`. Удалите их вручную, если хотите удалить все данные:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## Устранение неполадок

### Pod завис в CrashLoopBackOff

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

Распространённые причины: отсутствующие секреты, некорректный ADMIN_PUBKEY, PostgreSQL недоступен, RustFS не готов.

### Ошибки подключения к базе данных

Убедитесь, что PostgreSQL доступен из кластера:

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Ingress не работает

Убедитесь, что контроллер Ingress запущен и ресурс Ingress имеет адрес:

```bash
kubectl get ingress llamenos
kubectl describe ingress llamenos
```

## Следующие шаги

- [Руководство администратора](/docs/admin-guide) — настройка горячей линии
- [Обзор самостоятельного хостинга](/docs/deploy/self-hosting) — сравнение вариантов развёртывания
- [Развёртывание с Docker Compose](/docs/deploy/docker) — более простой вариант

Это руководство описывает развёртывание Llamenos в кластере Kubernetes с помощью официального Helm-чарта. Чарт управляет приложением и опциональными сервисами RustFS/Whisper как отдельными развёртываниями. Базу данных PostgreSQL предоставляете вы.

## Предварительные требования

- Кластер Kubernetes (v1.24+) — управляемый (EKS, GKE, AKS) или самостоятельный
- Экземпляр PostgreSQL 14+ (рекомендуется управляемый RDS/Cloud SQL или самостоятельный хостинг)
- [Helm](https://helm.sh/) v3.10+
- [kubectl](https://kubernetes.io/docs/tasks/tools/), настроенный для вашего кластера
- Ingress-контроллер (NGINX Ingress, Traefik и др.)
- cert-manager (опционально, для автоматических TLS-сертификатов)
- [Bun](https://bun.sh/), установленный локально (для генерации ключевой пары администратора)


## 2. Установка чарта

```bash
helm install llamenos deploy/helm/llamenos/ \
  --set secrets.adminPubkey=YOUR_HEX_PUBLIC_KEY \
  --set secrets.postgresPassword=YOUR_PG_PASSWORD \
  --set postgres.host=YOUR_PG_HOST \
  --set rustfs.credentials.accessKey=your-access-key \
  --set rustfs.credentials.secretKey=your-secret-key \
  --set ingress.hosts[0].host=hotline.yourdomain.com \
  --set ingress.tls[0].secretName=llamenos-tls \
  --set ingress.tls[0].hosts[0]=hotline.yourdomain.com
```

Или создайте файл `values-production.yaml` для воспроизводимых развёртываний:

```yaml
# values-production.yaml
app:
  image:
    repository: ghcr.io/rhonda-rodododo/llamenos-platform
    tag: "1.0.0"
  replicas: 2
  env:
    HOTLINE_NAME: "Your Hotline"

postgres:
  host: my-rds-instance.region.rds.amazonaws.com
  port: 5432
  database: llamenos
  user: llamenos
  poolSize: 10

secrets:
  adminPubkey: "your_hex_public_key"
  postgresPassword: "your-strong-password"
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

whisper:
  enabled: true
  model: "Systran/faster-whisper-base"
  device: "cpu"
  resources:
    requests:
      memory: "2Gi"
      cpu: "1"
    limits:
      memory: "4Gi"
      cpu: "2"

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

Затем установите:

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## 3. Проверка развёртывания

```bash
# Проверка работы подов
kubectl get pods -l app.kubernetes.io/instance=llamenos

# Проверка здоровья приложения
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# → {"status":"ok"}
```

## 4. Настройка DNS

Направьте ваш домен на внешний IP или балансировщик нагрузки ingress-контроллера:

```bash
kubectl get ingress llamenos
```

## 5. Первый вход и настройка

Откройте `https://hotline.yourdomain.com` в браузере. Войдите с nsec администратора и завершите мастер настройки.

## Справочник по конфигурации чарта

### Приложение

| Параметр | Описание | По умолчанию |
|----------|---------|--------------|
| `app.image.repository` | Образ контейнера | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | Тег образа | Chart appVersion |
| `app.port` | Порт приложения | `3000` |
| `app.replicas` | Количество реплик подов | `2` |
| `app.resources` | Запросы и лимиты CPU/памяти | `{}` |
| `app.env` | Дополнительные переменные окружения | `{}` |

### PostgreSQL

| Параметр | Описание | По умолчанию |
|----------|---------|--------------|
| `postgres.host` | Имя хоста PostgreSQL (обязательно) | `""` |
| `postgres.port` | Порт PostgreSQL | `5432` |
| `postgres.database` | Имя базы данных | `llamenos` |
| `postgres.user` | Пользователь базы данных | `llamenos` |
| `postgres.poolSize` | Размер пула соединений | `10` |

### Секреты

| Параметр | Описание | По умолчанию |
|----------|---------|--------------|
| `secrets.hmacSecret` | HMAC signing key — 64 hex chars (required) | `""` |
| `secrets.serverWebSocketSecret` | Server WebSocket identity key — 64 hex chars (required) | `""` |
| `secrets.postgresPassword` | Пароль PostgreSQL (обязательно) | `""` |
| `secrets.twilioAccountSid` | Twilio Account SID | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token | `""` |
| `secrets.twilioPhoneNumber` | Номер телефона Twilio (E.164) | `""` |
| `secrets.existingSecret` | Использовать существующий K8s Secret | `""` |

> **Совет**: Для продакшена используйте `secrets.existingSecret` для ссылки на Secret, управляемый External Secrets Operator, Sealed Secrets или Vault.

### RustFS

| Параметр | Описание | По умолчанию |
|----------|---------|--------------|
| `rustfs.enabled` | Развернуть RustFS | `true` |
| `rustfs.image.repository` | Образ RustFS | `rustfs/rustfs` |
| `rustfs.image.tag` | Тег RustFS | `RELEASE.2025-01-20T14-49-07Z` |
| `rustfs.persistence.size` | Том данных RustFS | `50Gi` |
| `rustfs.persistence.storageClass` | Класс хранения | `""` |
| `rustfs.credentials.accessKey` | Корневой пользователь RustFS | `""` (обязательно) |
| `rustfs.credentials.secretKey` | Корневой пароль RustFS | `""` (обязательно) |
| `rustfs.resources` | Запросы и лимиты CPU/памяти | `{}` |

### Транскрипция Whisper

| Параметр | Описание | По умолчанию |
|----------|---------|--------------|
| `whisper.enabled` | Развернуть Whisper | `false` |
| `whisper.image.repository` | Образ Whisper | `fedirz/faster-whisper-server` |
| `whisper.image.tag` | Тег Whisper | `0.4.1` |
| `whisper.model` | Имя модели Whisper | `Systran/faster-whisper-base` |
| `whisper.device` | Устройство: `cpu` или `cuda` | `cpu` |
| `whisper.resources` | Запросы и лимиты CPU/памяти | `{}` |

### Ingress

| Параметр | Описание | По умолчанию |
|----------|---------|--------------|
| `ingress.enabled` | Создать ресурс Ingress | `true` |
| `ingress.className` | Класс Ingress | `nginx` |
| `ingress.annotations` | Аннотации Ingress | `{}` |
| `ingress.hosts` | Правила хостов | См. values.yaml |
| `ingress.tls` | Конфигурация TLS | `[]` |

### Сервисный аккаунт

| Параметр | Описание | По умолчанию |
|----------|---------|--------------|
| `serviceAccount.create` | Создать ServiceAccount | `true` |
| `serviceAccount.annotations` | Аннотации SA (напр., IRSA) | `{}` |
| `serviceAccount.name` | Переопределение имени SA | `""` |

## Использование внешних секретов

Для продакшена не помещайте секреты непосредственно в значения Helm. Вместо этого создайте Secret отдельно и укажите ссылку:

```yaml
# values-production.yaml
secrets:
  existingSecret: llamenos-secrets
```

Создайте Secret предпочтительным инструментом:

```bash
# Вручную
kubectl create secret generic llamenos-secrets \
  --from-literal=hmac-secret=your_hmac_hex \
  --from-literal=server-WebSocket-secret=your_WebSocket_hex \
  --from-literal=postgres-password=your_password \
  --from-literal=rustfs-access-key=your_key \
  --from-literal=rustfs-secret-key=your_key

# Или с помощью External Secrets Operator, Sealed Secrets, Vault и др.
```

## Использование внешнего RustFS или S3

Если у вас уже есть RustFS или S3-совместимый сервис, отключите встроенный RustFS и передайте endpoint:

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

## GPU-транскрипция

Для GPU-ускоренной транскрипции Whisper на NVIDIA GPU:

```yaml
whisper:
  enabled: true
  device: "cuda"
  model: "Systran/faster-whisper-large-v3"
  resources:
    limits:
      nvidia.com/gpu: 1
```

Убедитесь, что в кластере установлен [NVIDIA device plugin](https://github.com/NVIDIA/k8s-device-plugin).

## Масштабирование

Развёртывание использует стратегию `RollingUpdate` для обновлений без простоя. Масштабируйте реплики в зависимости от трафика:

```bash
kubectl scale deployment llamenos --replicas=3
```

Или установите `app.replicas` в файле значений. PostgreSQL advisory locks обеспечивают согласованность данных между репликами.


## Мониторинг

### Проверки здоровья

Чарт настраивает liveness, readiness и startup пробы для `/api/health`:

```yaml
# Встроено в шаблон развёртывания
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

### Логи

```bash
kubectl logs -l app.kubernetes.io/instance=llamenos -c app -f
```

## Обновление

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

Стратегия `RollingUpdate` обеспечивает обновления без простоя.

## Удаление

```bash
helm uninstall llamenos
```

> **Примечание**: PersistentVolumeClaims не удаляются при `helm uninstall`. Удалите их вручную, если хотите удалить все данные:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## Устранение неполадок

### Под застрял в CrashLoopBackOff

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

Частые причины: отсутствующие секреты, неверный ADMIN_PUBKEY, недоступный PostgreSQL, неготовый RustFS.

### Ошибки подключения к базе данных

Проверьте доступность PostgreSQL из кластера:

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Ingress не работает

Проверьте, что ingress-контроллер запущен и ресурс Ingress имеет адрес:

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


## Следующие шаги

- [Руководство администратора](/docs/admin-guide) — настройка горячей линии
- [Обзор самостоятельного хостинга](/docs/deploy/self-hosting) — сравнение вариантов развёртывания
- [Развёртывание с Docker Compose](/docs/deploy/docker) — более простая альтернатива
