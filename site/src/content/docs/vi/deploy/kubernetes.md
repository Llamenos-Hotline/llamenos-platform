---
title: "Triển khai: Kubernetes (Helm)"
description: Triển khai Llamenos lên Kubernetes sử dụng Helm chart chính thức.
---

Hướng dẫn này bao gồm việc triển khai Llamenos lên cụm Kubernetes sử dụng Helm chart chính thức. Chart quản lý ứng dụng và các dịch vụ RustFS/Whisper tùy chọn dưới dạng các deployment riêng biệt. Bạn cung cấp cơ sở dữ liệu PostgreSQL.

## Yêu cầu tiên quyết

- Một cụm Kubernetes (v1.24+) — được quản lý (EKS, GKE, AKS) hoặc tự lưu trữ
- Một phiên bản PostgreSQL 14+ (khuyến nghị RDS/Cloud SQL được quản lý, hoặc tự lưu trữ)
- [Helm](https://helm.sh/) v3.10+
- [kubectl](https://kubernetes.io/docs/tasks/tools/) đã cấu hình cho cụm của bạn
- Một ingress controller (NGINX Ingress, Traefik, v.v.)
- cert-manager (tùy chọn, cho chứng chỉ TLS tự động)
- [Bun](https://bun.sh/) cài đặt trên máy cục bộ (để tạo cặp khóa quản trị)


## 2. Cài đặt chart

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

Hoặc tạo file `values-production.yaml` để triển khai tái lập:

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

Sau đó cài đặt:

```bash
helm install llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## 3. Xác minh triển khai

```bash
kubectl get pods -l app.kubernetes.io/instance=llamenos
kubectl port-forward svc/llamenos 3000:3000
curl http://localhost:3000/health/ready
# → {"status":"ok"}
```

## 4. Cấu hình DNS

Trỏ tên miền đến IP bên ngoài hoặc load balancer của ingress controller:

```bash
kubectl get ingress llamenos
```

## 5. Đăng nhập và thiết lập lần đầu

Mở `https://hotline.yourdomain.com` trong trình duyệt. Đăng nhập bằng nsec quản trị và hoàn thành trình hướng dẫn thiết lập.

## Tham chiếu cấu hình Chart

### Ứng dụng

| Tham số | Mô tả | Mặc định |
|---------|-------|----------|
| `app.image.repository` | Container image | `ghcr.io/rhonda-rodododo/llamenos-platform` |
| `app.image.tag` | Image tag | Chart appVersion |
| `app.port` | Cổng ứng dụng | `3000` |
| `app.replicas` | Số bản sao Pod | `2` |
| `app.resources` | Yêu cầu và giới hạn CPU/bộ nhớ | `{}` |
| `app.env` | Biến môi trường bổ sung | `{}` |

### PostgreSQL

| Tham số | Mô tả | Mặc định |
|---------|-------|----------|
| `postgres.host` | Tên máy chủ PostgreSQL (bắt buộc) | `""` |
| `postgres.port` | Cổng PostgreSQL | `5432` |
| `postgres.database` | Tên cơ sở dữ liệu | `llamenos` |
| `postgres.user` | Người dùng cơ sở dữ liệu | `llamenos` |
| `postgres.poolSize` | Kích thước connection pool | `10` |

### Secrets

| Tham số | Mô tả | Mặc định |
|---------|-------|----------|
| `secrets.hmacSecret` | HMAC signing key — 64 hex chars (required) | `""` |
| `secrets.serverWebSocketSecret` | Server WebSocket identity key — 64 hex chars (required) | `""` |
| `secrets.postgresPassword` | Mật khẩu PostgreSQL (bắt buộc) | `""` |
| `secrets.twilioAccountSid` | Twilio Account SID | `""` |
| `secrets.twilioAuthToken` | Twilio Auth Token | `""` |
| `secrets.twilioPhoneNumber` | Số điện thoại Twilio (E.164) | `""` |
| `secrets.existingSecret` | Sử dụng K8s Secret hiện có | `""` |

> **Mẹo**: Cho production, sử dụng `secrets.existingSecret` để tham chiếu Secret được quản lý bởi External Secrets Operator, Sealed Secrets hoặc Vault.

### RustFS

| Tham số | Mô tả | Mặc định |
|---------|-------|----------|
| `rustfs.enabled` | Triển khai RustFS | `true` |
| `rustfs.persistence.size` | Dung lượng RustFS | `50Gi` |
| `rustfs.credentials.accessKey` | RustFS root user | `""` (bắt buộc) |
| `rustfs.credentials.secretKey` | RustFS root password | `""` (bắt buộc) |

### Whisper

| Tham số | Mô tả | Mặc định |
|---------|-------|----------|
| `whisper.enabled` | Triển khai Whisper | `false` |
| `whisper.model` | Tên mô hình Whisper | `Systran/faster-whisper-base` |
| `whisper.device` | Thiết bị: `cpu` hoặc `cuda` | `cpu` |

## Sử dụng external secrets

Cho production, tránh đặt secrets trực tiếp trong Helm values. Tạo Secret riêng và tham chiếu:

```yaml
secrets:
  existingSecret: llamenos-secrets
```

```bash
kubectl create secret generic llamenos-secrets \
  --from-literal=hmac-secret=your_hmac_hex \
  --from-literal=server-WebSocket-secret=your_WebSocket_hex \
  --from-literal=postgres-password=your_password \
  --from-literal=rustfs-access-key=your_key \
  --from-literal=rustfs-secret-key=your_key
```

## GPU transcription

```yaml
whisper:
  enabled: true
  device: "cuda"
  model: "Systran/faster-whisper-large-v3"
  resources:
    limits:
      nvidia.com/gpu: 1
```

Đảm bảo [NVIDIA device plugin](https://github.com/NVIDIA/k8s-device-plugin) đã được cài đặt trong cụm.

## Mở rộng

```bash
kubectl scale deployment llamenos --replicas=3
```

Hoặc đặt `app.replicas` trong values file. PostgreSQL advisory locks đảm bảo tính nhất quán dữ liệu qua các bản sao.

## Nâng cấp

```bash
helm upgrade llamenos deploy/helm/llamenos/ -f values-production.yaml
```

## Gỡ cài đặt

```bash
helm uninstall llamenos
```

> **Lưu ý**: `helm uninstall` không xóa PersistentVolumeClaim. Xóa thủ công nếu muốn loại bỏ tất cả dữ liệu:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=llamenos
> ```

## Khắc phục sự cố

### Pod bị kẹt ở CrashLoopBackOff

```bash
kubectl logs llamenos-0 -c app --previous
kubectl describe pod llamenos-0
```

Nguyên nhân phổ biến: thiếu secrets, ADMIN_PUBKEY không đúng, không thể kết nối PostgreSQL, RustFS chưa sẵn sàng.

### Lỗi kết nối cơ sở dữ liệu

```bash
kubectl run pg-test --rm -it --image=postgres:17-alpine -- psql postgresql://llamenos:PASSWORD@PG_HOST:5432/llamenos -c "SELECT 1"
```

### Ingress không hoạt động

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


## Bước tiếp theo

- [Hướng dẫn quản trị viên](/docs/admin-guide) — cấu hình đường dây nóng
- [Tổng quan tự lưu trữ](/docs/deploy/self-hosting) — so sánh các tùy chọn triển khai
- [Triển khai Docker Compose](/docs/deploy/docker) — phương án đơn giản hơn
