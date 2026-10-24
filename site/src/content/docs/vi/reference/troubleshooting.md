---
title: Khắc phục sự cố
description: Giải pháp cho các vấn đề phổ biến với triển khai, ứng dụng desktop, di động, dịch vụ điện thoại và phép toán mật mã.
---

Hướng dẫn này bao gồm các vấn đề phổ biến và giải pháp cho tất cả các chế độ triển khai và nền tảng Llamenos.

## Vấn đề triển khai Docker

### Container không khởi động được

**Thiếu biến môi trường:**

Docker Compose xác thực tất cả dịch vụ khi khởi động, kể cả những dịch vụ có profile. Đảm bảo file `.env` có tất cả giá trị cần thiết:

```bash
PG_PASSWORD=your_postgres_password
STORAGE_ACCESS_KEY=your_rustfs_access_key
STORAGE_SECRET_KEY=your_rustfs_secret_key
HMAC_SECRET=your_hmac_secret
ARI_PASSWORD=your_ari_password       # Bắt buộc ngay cả khi không dùng Asterisk
BRIDGE_SECRET=your_bridge_secret     # Bắt buộc ngay cả khi không dùng Asterisk
ADMIN_PUBKEY=your_admin_hex_pubkey
```

**Xung đột cổng:**

```bash
sudo lsof -i :8787
sudo lsof -i :5432
sudo lsof -i :9000
```

### Lỗi kết nối cơ sở dữ liệu

- Xác minh `PG_PASSWORD` trong `.env` khớp với khi tạo container lần đầu
- Kiểm tra container PostgreSQL: `docker compose ps`
- Nếu đã thay đổi mật khẩu: `docker compose down -v && docker compose up -d`

### Strfry relay không kết nối

WebSocket relay là dịch vụ cốt lõi, không tùy chọn:

```bash
docker compose logs WebSocket relay
docker compose restart WebSocket relay
```

### Lỗi RustFS / S3

- Xác minh `STORAGE_ACCESS_KEY` và `STORAGE_SECRET_KEY`
- Kiểm tra container RustFS: `docker compose ps rustfs`
- Truy cập RustFS console tại `http://localhost:9001`

## Vấn đề triển khai Cloudflare

### Lỗi Durable Object

- Chạy `bun run deploy` (không bao giờ chạy `wrangler deploy` trực tiếp)
- Kiểm tra `wrangler.jsonc` cho tên lớp DO và bindings đúng
- Durable Objects có giới hạn 128 KB mỗi cặp key-value

### Lỗi Worker (phản hồi 500)

```bash
bunx wrangler tail
```

Nguyên nhân phổ biến: thiếu secrets, `ADMIN_PUBKEY` sai định dạng (phải 64 ký tự hex), rate limiting gói miễn phí.

### Lỗi "Pages deploy"

Không bao giờ chạy `wrangler pages deploy` hoặc `wrangler deploy` trực tiếp:

```bash
bun run deploy          # Triển khai tất cả
bun run deploy:site     # Chỉ trang marketing
```

## Vấn đề ứng dụng desktop

### Cập nhật tự động không hoạt động

- Kiểm tra kết nối internet
- Xác minh endpoint cập nhật: `https://github.com/rhonda-rodododo/llamenos-platform/releases/latest/download/latest.json`
- Linux: AppImage cần quyền ghi trong thư mục
- macOS: ứng dụng phải ở `/Applications`

### Mở khóa PIN thất bại

- Đảm bảo nhập đúng PIN (không có chức năng khôi phục PIN)
- PIN phân biệt chữ hoa/thường nếu chứa chữ cái
- Nếu quên PIN, nhập lại nsec để đặt PIN mới. Ghi chú vẫn truy cập được vì gắn với danh tính, không phải PIN

### Khôi phục khóa

1. Dùng nsec (lưu trong trình quản lý mật khẩu) đăng nhập thiết bị mới
2. Nếu đã đăng ký WebAuthn passkey, dùng nó trên thiết bị mới
3. Ghi chú mã hóa lưu phía máy chủ — giải mã được khi đăng nhập cùng danh tính
4. Nếu mất cả nsec và passkey, liên hệ quản trị viên

### Ứng dụng không khởi động (cửa sổ trắng)

- Kiểm tra yêu cầu hệ thống tối thiểu
- Linux: `sudo apt install libwebkit2gtk-4.1-0`
- Chạy từ terminal để xem lỗi: `./llamenos`
- Wayland: thử `GDK_BACKEND=x11`

### Xung đột đơn phiên bản

- Kiểm tra tiến trình nền: `ps aux | grep llamenos`
- Kết thúc tiến trình mồ côi: `pkill llamenos`

## Vấn đề ứng dụng di động

### Lỗi cung cấp

Xem [Hướng dẫn di động](/docs/mobile-guide#khac-phuc-su-co-di-dong) để biết chi tiết.

Nguyên nhân phổ biến: mã QR hết hạn (5 phút), không có internet, phiên bản giao thức khác nhau.

### Thông báo đẩy không đến

- Kiểm tra quyền thông báo trong cài đặt OS
- Android: kiểm tra tối ưu hóa pin
- iOS: bật Background App Refresh cho Llamenos
- Xác minh ca trực đang hoạt động

## Vấn đề dịch vụ điện thoại

### Cấu hình webhook Twilio

1. Xác minh URL webhook trong Twilio console:
   - Voice: `https://your-worker.your-domain.com/telephony/incoming` (POST)
   - Status callback: `https://your-worker.your-domain.com/telephony/status` (POST)
2. Kiểm tra thông tin Twilio trong cài đặt:
   - Account SID, Auth Token
   - Số điện thoại (phải có mã quốc gia, ví dụ `+1234567890`)
3. Kiểm tra Twilio debugger: [twilio.com/console/debugger](https://www.twilio.com/console/debugger)

### Cuộc gọi kết nối nhưng không có âm thanh

- Kiểm tra NAT/tường lửa cho lưu lượng RTP
- Nếu dùng WebRTC, xác minh cấu hình STUN/TURN
- Một số VPN chặn VoIP — thử không dùng VPN

### Tin nhắn SMS/WhatsApp không đến

- Xác minh URL webhook tin nhắn
- WhatsApp: kiểm tra Meta webhook verification token
- Kiểm tra kênh tin nhắn đã bật trong **Cài đặt quản trị > Kênh**
- Signal: xác minh cầu nối signal-cli đang chạy

## Lỗi mật mã

### Lỗi không khớp khóa

**"Giải mã thất bại" hoặc "Khóa không hợp lệ":**

- Ghi chú được mã hóa cho danh tính khác với đang đăng nhập
- Xác minh nsec đúng (kiểm tra npub trong Cài đặt)
- Ghi chú cũ cho khóa công khai cũ không giải mã được bằng khóa mới

**"Chữ ký không hợp lệ" khi đăng nhập:**

- nsec có thể bị hỏng — nhập lại từ trình quản lý mật khẩu
- Đảm bảo đầy đủ nsec (bắt đầu `nsec1`, 63 ký tự)

### Lỗi phong bì ECIES

**"Giải bọc khóa thất bại":** Phong bì ECIES có thể được tạo với khóa công khai sai. Quản trị viên cần xác minh và mời lại.

**"Độ dài bản mã không hợp lệ":** Hỏng dữ liệu, có thể từ phản hồi mạng bị cắt. Thử lại thao tác.

### Lỗi Hub key

**"Giải mã sự kiện hub thất bại":** Đóng và mở lại ứng dụng để lấy hub key mới nhất.

## Nhận trợ giúp

- Kiểm tra [GitHub Issues](https://github.com/rhonda-rodododo/llamenos-platform/issues)
- Tìm kiếm issue hiện có trước khi tạo mới
- Khi báo lỗi, bao gồm: chế độ triển khai, nền tảng và thông báo lỗi
