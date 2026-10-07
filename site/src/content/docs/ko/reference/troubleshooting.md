---
title: 문제 해결
description: 배포, 데스크톱 앱, 모바일 앱, 전화 서비스 및 암호화 작업의 일반적인 문제에 대한 해결책.
---

이 가이드는 모든 Llamenos 배포 모드 및 플랫폼에서 발생하는 일반적인 문제와 해결 방법을 다룹니다.

## Docker 배포 문제

### 컨테이너 시작 실패

**누락된 환경 변수:**

Docker Compose는 프로파일된 서비스를 포함하여 시작 시 모든 서비스를 검증합니다. 누락된 변수에 대한 오류가 발생하면, `.env` 파일에 모든 필수 값이 포함되어 있는지 확인하세요:

```bash
# Docker Compose에 .env에서 필수
PG_PASSWORD=your_postgres_password
STORAGE_ACCESS_KEY=your_rustfs_access_key
STORAGE_SECRET_KEY=your_rustfs_secret_key
HMAC_SECRET=your_hmac_secret
ARI_PASSWORD=your_ari_password       # Asterisk를 사용하지 않더라도 필수
BRIDGE_SECRET=your_bridge_secret     # Asterisk를 사용하지 않더라도 필수
ADMIN_PUBKEY=your_admin_hex_pubkey
```

Asterisk 브리지를 사용하지 않더라도, Docker Compose는 해당 서비스 정의를 검증하므로 `ARI_PASSWORD`와 `BRIDGE_SECRET`이 설정되어야 합니다.

**포트 충돌:**

포트가 이미 사용 중인 경우, 어떤 프로세스가 사용하는지 확인하세요:

```bash
# 포트 8787 (Worker) 사용 확인
sudo lsof -i :8787

# 포트 5432 (PostgreSQL) 사용 확인
sudo lsof -i :5432

# 포트 9000 (RustFS) 사용 확인
sudo lsof -i :9000
```

충돌하는 프로세스를 중지하거나 `docker-compose.yml`에서 포트 매핑을 변경하세요.

### 데이터베이스 연결 오류

앱이 PostgreSQL에 연결할 수 없는 경우:

- `.env`의 `PG_PASSWORD`가 컨테이너가 처음 생성될 때 사용된 값과 일치하는지 확인하세요
- PostgreSQL 컨테이너가 정상인지 확인하세요: `docker compose ps`
- 비밀번호가 변경된 경우, 볼륨을 제거하고 다시 생성해야 할 수 있습니다: `docker compose down -v && docker compose up -d`

### Strfry relay 연결 안 됨

WebSocket relay는 선택 사항이 아닌 핵심 서비스입니다. relay가 실행되지 않는 경우:

```bash
# relay 상태 확인
docker compose logs WebSocket relay

# relay 재시작
docker compose restart WebSocket relay
```

relay 시작이 실패하면, 포트 7777 충돌이나 데이터 디렉토리의 권한 부족을 확인하세요.

### RustFS / S3 스토리지 오류

- `STORAGE_ACCESS_KEY`와 `STORAGE_SECRET_KEY`가 올바른지 확인하세요
- RustFS 컨테이너가 실행 중인지 확인하세요: `docker compose ps rustfs`
- `http://localhost:9001`에서 RustFS 콘솔에 접근하여 버킷 생성을 확인하세요

## Cloudflare 배포 문제

### Durable Object 오류

**"Durable Object not found" 또는 바인딩 오류:**

- `bun run deploy`를 실행하세요 (`wrangler deploy`를 직접 실행하지 마세요) DO 바인딩이 올바른지 확인
- `wrangler.jsonc`에서 올바른 DO 클래스 이름과 바인딩을 확인하세요
- 새 DO를 추가한 후, 사용 가능하기 전에 배포해야 합니다

**DO 스토리지 제한:**

Cloudflare Durable Objects는 키-값 쌍당 128 KB 제한이 있습니다. 스토리지 오류가 발생하면:

- 메모 내용이 제한을 초과하지 않는지 확인하세요 (첨부 파일이 많은 매우 큰 메모)
- ECIES 봉투가 중복되지 않는지 확인하세요

### Worker 오류 (500 응답)

Worker 로그를 확인하세요:

```bash
bunx wrangler tail
```

일반적인 원인:
- 누락된 시크릿 (`bunx wrangler secret list`로 확인)
- 잘못된 `ADMIN_PUBKEY` 형식 (64자 16진수여야 하며, `npub` 접두사 없음)
- 무료 티어 요청 제한 (Workers Free에서 분당 1,000건)

### "Pages deploy" 오류로 배포 실패

`wrangler pages deploy`나 `wrangler deploy`를 직접 실행하지 마세요. 항상 root `package.json` 스크립트를 사용하세요:

```bash
bun run deploy          # 전체 배포 (앱 + 마케팅 사이트)
bun run deploy:site     # 마케팅 사이트만 배포
```

잘못된 디렉토리에서 `wrangler pages deploy dist`를 실행하면 Vite 앱 빌드가 Astro 사이트 대신 Pages에 배포되어 마케팅 사이트에 404 오류가 발생합니다.

## 데스크톱 앱 문제

### 자동 업데이트가 작동하지 않는 경우

데스크톱 앱은 Tauri updater를 사용하여 새 버전을 확인합니다. 업데이트가 감지되지 않는 경우:

- 인터넷 연결을 확인하세요
- 업데이트 엔드포인트에 접근 가능한지 확인하세요: `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- Linux에서 AppImage 자동 업데이트는 파일이 해당 디렉토리에서 쓰기 권한을 가져야 합니다
- macOS에서 앱은 `/Applications`에 있어야 합니다 (DMG에서 직접 실행하면 안 됨)

수동 업데이트는 [다운로드](/download) 페이지에서 최신 릴리스를 다운로드하세요.

### PIN 잠금 해제 실패

데스크톱 앱에서 PIN이 거부되는 경우:

- 올바른 PIN을 입력하고 있는지 확인하세요 ("PIN 분실" 복구는 없음)
- PIN에 문자가 포함된 경우 대소문자를 구분합니다
- PIN을 잊어버린 경우, nsec을 다시 입력하여 새 PIN을 설정해야 합니다. 암호화된 메모는 PIN이 아닌 신원에 연결되어 있으므로 접근 가능합니다
- Tauri Stronghold는 PIN 파생 키(PBKDF2)로 nsec을 암호화합니다. 잘못된 PIN은 잘못된 복호화를 생성하며 오류 메시지가 아닙니다 — 앱은 파생된 공개 키를 검증하여 이를 감지합니다

### 키 복구

기기 접근을 잃어버린 경우:

1. nsec(비밀번호 관리자에 저장해 두었어야 함)을 사용하여 새 기기에서 로그인하세요
2. WebAuthn passkey를 등록한 경우, 새 기기에서 사용할 수 있습니다
3. 암호화된 메모는 서버 측에 저장됩니다 — 동일한 신원으로 로그인하면 복호화할 수 있습니다
4. nsec과 passkey 모두를 잃어버린 경우, 관리자에게 문의하세요. 관리자는 nsec을 복구할 수 없지만, 새 신원을 만들 수 있습니다. 이전 신원으로 암호화된 메모는 더 이상 읽을 수 없습니다

### 앱이 시작되지 않는 경우 (빈 창)

- 시스템이 최소 요구 사항을 충족하는지 확인하세요 ([다운로드](/download) 참조)
- Linux에서 WebKitGTK가 설치되어 있는지 확인하세요: `sudo apt install libwebkit2gtk-4.1-0` (Debian/Ubuntu) 또는 해당 패키지
- 터미널에서 실행하여 오류 출력을 확인하세요: `./llamenos` (AppImage) 또는 시스템 로그 확인
- Wayland를 사용하는 경우, 대체 방법으로 `GDK_BACKEND=x11`을 시도하세요

### 단일 인스턴스 충돌

Llamenos는 단일 인스턴스 모드를 적용합니다. 앱이 이미 실행 중이라고 하지만 창을 찾을 수 없는 경우:

- 백그라운드 프로세스를 확인하세요: `ps aux | grep llamenos`
- 고아 프로세스를 종료하세요: `pkill llamenos`
- Linux에서 앱이 충돌한 경우 오래된 잠금 파일을 확인하고 제거하세요

## 모바일 앱 문제

### 프로비저닝 실패

자세한 프로비저닝 문제 해결은 [모바일 가이드](/docs/mobile-guide#모바일-문제-해결)를 참조하세요.

일반적인 원인:
- 만료된 QR 코드 (토큰은 5분 후 만료)
- 어느 기기에든 인터넷 연결 없음
- 데스크톱 앱과 모바일 앱이 서로 다른 프로토콜 버전을 실행

### 푸시 알림 도착하지 않음

- OS 설정에서 알림 권한이 부여되었는지 확인하세요
- Android에서 배터리 최적화가 백그라운드에서 앱을 종료하지 않는지 확인하세요
- iOS에서 Llamenos에 대해 백그라운드 앱 새로 고침이 활성화되어 있는지 확인하세요
- 활성 근무가 있고 휴식 중이 아닌지 확인하세요

## 전화 서비스 문제

### Twilio 웹훅 설정

통화가 자원봉사자에게 라우팅되지 않는 경우:

1. Twilio 콘솔에서 웹훅 URL이 올바른지 확인하세요:
   - 음성 웹훅: `https://your-worker.your-domain.com/telephony/incoming` (POST)
   - 상태 콜백: `https://your-worker.your-domain.com/telephony/status` (POST)
2. 설정의 Twilio 자격 증명이 콘솔과 일치하는지 확인하세요:
   - Account SID
   - Auth Token
   - 전화번호 (국가 코드 포함, 예: `+1234567890`)
3. Twilio 디버거에서 오류를 확인하세요: [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### 번호 설정

- 전화번호는 Twilio 소유 번호이거나 확인된 발신자 ID여야 합니다
- 로컬 개발의 경우, Cloudflare Tunnel 또는 ngrok를 사용하여 로컬 Worker를 Twilio에 노출하세요
- 번호의 Voice 설정이 기본 TwiML Bin이 아닌 웹훅 URL을 가리키는지 확인하세요

### 통화 연결되지만 오디오 없음

- 전화 서비스 제공업체의 미디어 서버가 자원봉사자의 전화에 도달할 수 있는지 확인하세요
- RTP 트래픽을 차단하는 NAT/방화벽 문제를 확인하세요
- WebRTC를 사용하는 경우, STUN/TURN 서버가 올바르게 설정되어 있는지 확인하세요
- 일부 VPN은 VoIP 트래픽을 차단합니다 — VPN 없이 시도하세요

### SMS/WhatsApp 메시지 도착하지 않음

- 제공업체 콘솔에서 메시징 웹훅 URL이 올바르게 설정되어 있는지 확인하세요
- WhatsApp의 경우, Meta 웹훅 확인 토큰이 설정과 일치하는지 확인하세요
- **관리자 설정 > 채널**에서 메시징 채널이 활성화되어 있는지 확인하세요
- Signal의 경우, signal-cli 브리지가 실행 중이고 웹훅으로 전달하도록 설정되어 있는지 확인하세요

## 암호화 오류

### 키 불일치 오류

**메모를 열 때 "Failed to decrypt" 또는 "Invalid key":**

- 이는 일반적으로 현재 로그인한 신원과 다른 신원으로 메모가 암호화되었음을 의미합니다
- 올바른 nsec을 사용하고 있는지 확인하세요 (설정에서 npub이 관리자가 보는 것과 일치하는지 확인)
- 최근 신원을 재생성한 경우, 이전 공개 키로 암호화된 이전 메모는 새 키로 복호화할 수 없습니다

**로그인 시 "Invalid signature":**

- nsec이 손상되었을 수 있습니다 — 비밀번호 관리자에서 다시 입력하세요
- 전체 nsec이 붙여넣어졌는지 확인하세요 (`nsec1`로 시작, 총 63자)
- 추가 공백이나 줄바꿈 문자를 확인하세요

### 서명 검증 실패

허브 이벤트의 서명 검증이 실패하는 경우:

- 시스템 시계가 동기화되어 있는지 확인하세요 (NTP). 큰 시계 편차가 이벤트 타임스탬프에 문제를 일으킬 수 있습니다
- WebSocket relay가 알 수 없는 pubkey의 이벤트를 중계하고 있지 않은지 확인하세요
- 앱을 재시작하여 현재 허브 멤버 목록을 다시 가져오세요

### ECIES 봉투 오류

**메모 복호화 시 "Failed to unwrap key":**

- 잘못된 공개 키로 ECIES 봉투가 생성되었을 수 있습니다
- 이는 관리자가 자원봉사자의 pubkey에 오타를 입력하여 추가한 경우 발생할 수 있습니다
- 관리자는 자원봉사자의 공개 키를 확인하고 필요한 경우 다시 초대해야 합니다

**"Invalid ciphertext length":**

- 잘린 네트워크 응답 등으로 인한 데이터 손상을 나타냅니다
- 작업을 다시 시도하세요. 문제가 지속되면 암호화된 데이터가 영구적으로 손상되었을 수 있습니다
- 응답 본문을 잘라낼 수 있는 프록시 또는 CDN 문제를 확인하세요

### 허브 키 오류

**"Failed to decrypt hub event":**

- 마지막 연결 이후 허브 키가 순환되었을 수 있습니다
- 앱을 닫고 다시 열어 최신 허브 키를 가져오세요
- 최근 허브에서 제거되었다가 다시 추가된 경우, 부재 중에 키가 순환되었을 수 있습니다

## 도움 받기

여기에서 문제를 찾을 수 없는 경우:

- [GitHub Issues](https://github.com/rhonda-rodododo/llamenos-platform/issues)에서 알려진 버그와 해결 방법을 확인하세요
- 새 이슈를 만들기 전에 기존 이슈를 검색하세요
- 버그를 신고할 때 다음을 포함하세요: 배포 모드 (Cloudflare/Docker/Kubernetes), 플랫폼 (데스크톱/모바일), 브라우저 콘솔 또는 터미널의 오류 메시지
