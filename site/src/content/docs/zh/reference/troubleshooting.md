---
title: 故障排除
description: 部署、桌面应用、移动应用、电话服务和密码学操作常见问题的解决方案。
---

本指南涵盖所有 Llamenos 部署模式和平台的常见问题及其解决方案。

## Docker 部署问题

### 容器启动失败

**缺少环境变量：**

Docker Compose 在启动时验证所有服务，包括使用 profile 的服务。如果您看到关于缺少变量的错误，请确保您的 `.env` 文件包含所有必需的值：

```bash
# .env 中 Docker Compose 必需的变量
PG_PASSWORD=your_postgres_password
STORAGE_ACCESS_KEY=your_rustfs_access_key
STORAGE_SECRET_KEY=your_rustfs_secret_key
HMAC_SECRET=your_hmac_secret
ARI_PASSWORD=your_ari_password       # 即使不使用 Asterisk 也必须设置
BRIDGE_SECRET=your_bridge_secret     # 即使不使用 Asterisk 也必须设置
ADMIN_PUBKEY=your_admin_hex_pubkey
```

即使您不使用 Asterisk 桥接，Docker Compose 也会验证其服务定义，因此需要设置 `ARI_PASSWORD` 和 `BRIDGE_SECRET`。

**端口冲突：**

如果端口已被占用，请检查哪个进程在使用它：

```bash
# 检查端口 8787 (Worker) 的占用
sudo lsof -i :8787

# 检查端口 5432 (PostgreSQL) 的占用
sudo lsof -i :5432

# 检查端口 9000 (RustFS) 的占用
sudo lsof -i :9000
```

停止冲突的进程或在 `docker-compose.yml` 中更改端口映射。

### 数据库连接错误

如果应用程序无法连接到 PostgreSQL：

- 验证 `.env` 中的 `PG_PASSWORD` 与容器首次创建时使用的密码一致
- 检查 PostgreSQL 容器是否健康：`docker compose ps`
- 如果密码已更改，您可能需要删除卷并重新创建：`docker compose down -v && docker compose up -d`

### Strfry relay 未连接

WebSocket relay 是核心服务，不是可选的。如果 relay 未运行：

```bash
# 检查 relay 状态
docker compose logs WebSocket relay

# 重启 relay
docker compose restart WebSocket relay
```

如果 relay 启动失败，请检查 7777 端口冲突或数据目录权限不足。

### RustFS / S3 存储错误

- 验证 `STORAGE_ACCESS_KEY` 和 `STORAGE_SECRET_KEY` 是否正确
- 检查 RustFS 容器是否正在运行：`docker compose ps rustfs`
- 访问 RustFS 控制台 `http://localhost:9001` 验证存储桶创建

## Cloudflare 部署问题

### Durable Object 错误

**"Durable Object not found"或绑定错误：**

- 运行 `bun run deploy`（切勿直接运行 `wrangler deploy`）以确保 DO 绑定正确
- 检查 `wrangler.jsonc` 中的 DO 类名和绑定是否正确
- 添加新 DO 后，必须先部署才能使用

**DO 存储限制：**

Cloudflare Durable Objects 每个键值对有 128 KB 的限制。如果您看到存储错误：

- 确保备注内容没有超过限制（带有大量附件的超大备注）
- 检查 ECIES 信封是否被重复

### Worker 错误（500 响应）

检查 Worker 日志：

```bash
bunx wrangler tail
```

常见原因：
- 缺少密钥（使用 `bunx wrangler secret list` 验证）
- `ADMIN_PUBKEY` 格式不正确（必须是 64 个十六进制字符，不含 `npub` 前缀）
- 免费版速率限制（Workers Free 每分钟 1,000 个请求）

### 部署失败并出现"Pages deploy"错误

切勿直接运行 `wrangler pages deploy` 或 `wrangler deploy`。请始终使用根 `package.json` 中的脚本：

```bash
bun run deploy          # 部署所有内容（应用 + 营销网站）
bun run deploy:site     # 仅部署营销网站
```

在错误的目录中运行 `wrangler pages deploy dist` 会将 Vite 应用构建部署到 Pages 而不是 Astro 网站，导致营销网站出现 404 错误。

## 桌面应用问题

### 自动更新不工作

桌面应用使用 Tauri updater 检查新版本。如果更新未被检测到：

- 检查您的互联网连接
- 验证更新端点是否可访问：`https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- 在 Linux 上，AppImage 自动更新需要文件所在目录具有写权限
- 在 macOS 上，应用必须在 `/Applications` 中（不能直接从 DMG 运行）

要手动更新，请从[下载](/download)页面下载最新版本。

### PIN 解锁失败

如果桌面应用拒绝您的 PIN：

- 确保输入了正确的 PIN（没有"忘记 PIN"恢复功能）
- 如果 PIN 包含字母，则区分大小写
- 如果忘记了 PIN，需要重新输入 nsec 来设置新的 PIN。您的加密备注仍然可以访问，因为它们与您的身份绑定，而不是与 PIN 绑定
- Tauri Stronghold 使用 PIN 派生的密钥（PBKDF2）加密您的 nsec。错误的 PIN 会产生无效的解密，而不是错误消息——应用通过验证派生的公钥来检测这一点

### 密钥恢复

如果您丢失了设备访问权限：

1. 使用您的 nsec（应该存储在密码管理器中）在新设备上登录
2. 如果注册了 WebAuthn 通行密钥，可以在新设备上使用它
3. 您的加密备注存储在服务器端——使用相同身份登录后即可解密
4. 如果同时丢失了 nsec 和通行密钥，请联系管理员。他们无法恢复您的 nsec，但可以为您创建新身份。为旧身份加密的备注将不再可读

### 应用无法启动（空白窗口）

- 检查您的系统是否满足最低要求（请参阅[下载](/download)）
- 在 Linux 上，确保已安装 WebKitGTK：`sudo apt install libwebkit2gtk-4.1-0`（Debian/Ubuntu）或等效包
- 尝试从终端启动以查看错误输出：`./llamenos`（AppImage）或检查系统日志
- 如果使用 Wayland，请尝试使用 `GDK_BACKEND=x11` 作为备选方案

### 单实例冲突

Llamenos 强制单实例模式。如果应用提示已在运行但找不到窗口：

- 检查后台进程：`ps aux | grep llamenos`
- 终止孤立进程：`pkill llamenos`
- 在 Linux 上，如果应用崩溃，检查并删除过期的锁文件

## 移动应用问题

### 配对失败

请参阅[移动端指南](/docs/mobile-guide#移动端故障排除)了解详细的配对故障排除。

常见原因：
- 二维码过期（令牌在 5 分钟后过期）
- 任一设备没有互联网连接
- 桌面应用和移动应用运行不同的协议版本

### 推送通知未到达

- 在操作系统设置中验证是否已授予通知权限
- 在 Android 上，检查电池优化是否在后台终止应用
- 在 iOS 上，验证 Llamenos 是否启用了后台应用刷新
- 检查您是否有活动的排班且未处于休息中

## 电话服务问题

### Twilio Webhook 配置

如果来电未路由到志愿者：

1. 在 Twilio 控制台中验证 Webhook URL 是否正确：
   - 语音 Webhook：`https://your-worker.your-domain.com/telephony/incoming` (POST)
   - 状态回调：`https://your-worker.your-domain.com/telephony/status` (POST)
2. 检查设置中的 Twilio 凭据是否与控制台一致：
   - Account SID
   - Auth Token
   - 电话号码（必须包含国家代码，例如 `+1234567890`）
3. 在 Twilio debugger 中检查错误：[twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### 号码设置

- 电话号码必须是 Twilio 拥有的号码或已验证的来电显示
- 对于本地开发，使用 Cloudflare Tunnel 或 ngrok 将本地 Worker 暴露给 Twilio
- 验证号码的语音配置指向您的 Webhook URL，而不是默认的 TwiML Bin

### 通话接通但没有音频

- 确保电话服务提供商的媒体服务器可以访问志愿者的手机
- 检查 NAT/防火墙是否阻止了 RTP 流量
- 如果使用 WebRTC，验证 STUN/TURN 服务器是否正确配置
- 某些 VPN 会阻止 VoIP 流量——请尝试不使用 VPN

### SMS/WhatsApp 消息未到达

- 验证消息 Webhook URL 是否在提供商的控制台中正确配置
- 对于 WhatsApp，确保 Meta Webhook 验证令牌与您的设置匹配
- 检查是否在**管理设置 > 频道**中启用了消息频道
- 对于 Signal，验证 signal-cli 桥接是否正在运行并配置为转发到您的 Webhook

## 密码学错误

### 密钥不匹配错误

**打开备注时出现"解密失败"或"无效密钥"：**

- 这通常意味着备注是为与您当前登录身份不同的身份加密的
- 验证您使用的是正确的 nsec（在设置中检查您的 npub 是否与管理员看到的一致）
- 如果您最近重新创建了身份，为旧公钥加密的旧备注无法用新密钥解密

**登录时出现"无效签名"：**

- nsec 可能已损坏——请从密码管理器重新输入
- 确保完整的 nsec 已粘贴（以 `nsec1` 开头，共 63 个字符）
- 检查是否有多余的空格或换行符

### 签名验证失败

如果 hub 事件签名验证失败：

- 检查系统时钟是否已同步（NTP）。较大的时钟偏差可能导致事件时间戳问题
- 验证 WebSocket relay 是否在转发来自未知公钥的事件
- 重启应用以重新获取当前的 hub 成员列表

### ECIES 信封错误

**备注解密时出现"密钥解封失败"：**

- ECIES 信封可能是使用不正确的公钥创建的
- 如果管理员在添加志愿者时公钥有误，可能会发生这种情况
- 管理员应验证志愿者的公钥，必要时重新邀请

**"密文长度无效"：**

- 这表示数据损坏，可能来自截断的网络响应
- 重试操作。如果持续出现，加密数据可能已永久损坏
- 检查代理或 CDN 是否可能截断响应体

### Hub key 错误

**"解密 hub 事件失败"：**

- Hub key 可能在您上次连接后已轮换
- 关闭并重新打开应用以获取最新的 hub key
- 如果您最近被从 hub 中移除并重新添加，在您缺席期间密钥可能已轮换

## 获取帮助

如果您的问题未在此处涵盖：

- 检查 [GitHub Issues](https://github.com/rhonda-rodododo/llamenos-platform/issues) 了解已知的 bug 和解决方法
- 在创建新 issue 前搜索现有 issue
- 报告 bug 时，请包含：您的部署模式（Cloudflare/Docker/Kubernetes）、平台（桌面端/移动端）以及浏览器控制台或终端中的任何错误消息
