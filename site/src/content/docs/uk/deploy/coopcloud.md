---
title: "Розгортання: Co-op Cloud"
description: Розгорніть Llamenos як рецепт Co-op Cloud для кооперативних хостингових колективів.
---

Цей посібник проведе вас через розгортання Llamenos як рецепту [Co-op Cloud](https://coopcloud.tech). Co-op Cloud використовує Docker Swarm з Traefik для завершення TLS та CLI `abra` для стандартизованого керування додатками — ідеально для технічних кооперативів та невеликих хостингових колективів.

Рецепт підтримується в [окремому репозиторії](https://github.com/rhonda-rodododo/llamenos-template).

## Передумови

- Сервер з ініціалізованим [Docker Swarm](https://docs.docker.com/engine/swarm/) та запущеним [Traefik](https://doc.traefik.io/traefik/) як зворотним проксі
- [`abra` CLI](https://docs.coopcloud.tech/abra/install/), встановлений на вашому локальному комп'ютері
- Доменне ім'я з DNS, вказаним на IP вашого сервера
- SSH доступ до сервера

Якщо ви новачок у Co-op Cloud, спочатку дотримуйтесь [посібника з налаштування Co-op Cloud](https://docs.coopcloud.tech/intro/).

## Швидкий старт

```bash
# Додайте ваш сервер (якщо ще не додано)
abra server add hotline.example.com

# Клонуйте рецепт (abra шукає рецепти в ~/.abra/recipes/)
git clone https://github.com/rhonda-rodododo/llamenos-template.git \
  ~/.abra/recipes/llamenos

# Створіть новий додаток Llamenos
abra app new llamenos --server hotline.example.com --domain hotline.example.com

# Згенеруйте всі секрети
abra app secret generate -a hotline.example.com

# Розгорніть
abra app deploy hotline.example.com
```

Відвідайте `https://hotline.example.com` та дотримуйтесь інструкцій майстра налаштування, щоб створити обліковий запис адміністратора.

## Основні служби

Рецепт розгортає п'ять служб:

| Служба | Образ | Призначення |
|---------|-------|-------------|
| **web** | `nginx:1.27-alpine` | Зворотний проксі з мітками Traefik |
| **app** | `ghcr.io/rhonda-rodododo/llamenos-platform` | Сервер додатка Bun |
| **db** | `postgres:17-alpine` | База даних PostgreSQL |
| **RustFS** | `RustFS/RustFS` | S3-сумісне файлове сховище |
| **relay** | `dockurr/WebSocket relay` | Релей WebSocket для подій у реальному часі |

## Секрети

Усі секрети керуються через секрети Docker Swarm (версіоновані, незмінні):

| Секрет | Тип | Опис |
|--------|-----|------|
| `hmac_secret` | hex (64 символи) | Ключ підпису HMAC для токенів сесій |
| `server_WebSocket` | hex (64 символи) | Ідентифікаційний ключ сервера WebSocket |
| `db_password` | alnum (32 символи) | Пароль PostgreSQL |
| `RustFS_access` | alnum (20 символів) | Ключ доступу RustFS |
| `RustFS_secret` | alnum (40 символів) | Секретний ключ RustFS |

Згенеруйте всі секрети одночасно:

```bash
abra app secret generate -a hotline.example.com
```

Щоб змінити конкретний секрет:

```bash
# 1. Збільшіть версію в конфігурації додатка
abra app config hotline.example.com
# Змініть SECRET_HMAC_SECRET_VERSION=v2

# 2. Згенеруйте новий секрет
abra app secret generate hotline.example.com hmac_secret

# 3. Перерозгорніть
abra app deploy hotline.example.com
```

## Конфігурація

Відредагуйте конфігурацію додатка:

```bash
abra app config hotline.example.com
```

Ключові налаштування:

```env
DOMAIN=hotline.example.com
LETS_ENCRYPT_ENV=production

# Відображувана назва в додатку
HOTLINE_NAME=Моя гаряча лінія

# Телефонний провайдер (налаштуйте після майстра)
# PBX_TYPE=twilio
# TWILIO_ACCOUNT_SID=
# TWILIO_AUTH_TOKEN=
# TWILIO_PHONE_NUMBER=

# Або SignalWire
# PBX_TYPE=signalwire
# SIGNALWIRE_PROJECT_ID=
# SIGNALWIRE_AUTH_TOKEN=
# SIGNALWIRE_PHONE_NUMBER=
# SIGNALWIRE_SPACE_URL=

# Версіонування секретів (змініть для ротації)
SECRET_HMAC_SECRET_VERSION=v1
SECRET_SERVER_NOSTR_VERSION=v1
SECRET_DB_PASSWORD_VERSION=v1
SECRET_STORAGE_ACCESS_VERSION=v1
SECRET_STORAGE_SECRET_VERSION=v1
```

## Перший вхід

Після розгортання відкрийте ваш домен у браузері та дотримуйтесь інструкцій майстра налаштування:

1. **Створіть обліковий запис адміністратора** — встановіть відображуване ім'я та PIN-код
2. **Назвіть свою гарячу лінію** — встановіть назву, яка відображатиметься в додатку
3. **Виберіть канали** — увімкніть голосовий зв'язок, SMS, WhatsApp, Signal та/або звіти
4. **Налаштуйте провайдерів** — введіть облікові дані для кожного увімкненого каналу
5. **Перевірте та завершіть**

## Налаштування вебхуків

Вкажіть вебхуки вашого телефонного провайдера на ваш домен:

- **Голос (вхідний)**: `https://hotline.example.com/api/telephony/incoming`
- **Голос (статус)**: `https://hotline.example.com/api/telephony/status`
- **SMS**: `https://hotline.example.com/api/messaging/sms/webhook`
- **WhatsApp**: `https://hotline.example.com/api/messaging/whatsapp/webhook`
- **Signal**: Налаштуйте міст для перенаправлення на `https://hotline.example.com/api/messaging/signal/webhook`

Перегляньте посібники для конкретних провайдерів: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo).

## Опціонально: Увімкнення сайдкара Signal

Для обміну повідомленнями Signal (див. [налаштування Signal](/docs/en/deploy/providers/signal)):

```bash
abra app config hotline.example.com
```

Встановіть:

```env
COMPOSE_FILE=compose.yml:compose.signal.yml
SECRET_SIGNAL_NOTIFIER_TOKEN_VERSION=v1
```

Згенеруйте додатковий секрет та перерозгорніть:

```bash
abra app secret generate hotline.example.com signal_notifier_token
abra app deploy hotline.example.com
```

## Опціонально: Увімкнення SIP моста

Для самостійно розміщеної SIP телефонії через Asterisk, FreeSWITCH або Kamailio:

```bash
abra app config hotline.example.com
```

Встановіть:

```env
COMPOSE_FILE=compose.yml:compose.telephony.yml
PBX_TYPE=asterisk
SECRET_ARI_PASSWORD_VERSION=v1
SECRET_BRIDGE_SECRET_VERSION=v1
```

Згенеруйте додаткові секрети та перерозгорніть:

```bash
abra app secret generate hotline.example.com ari_password bridge_secret
abra app deploy hotline.example.com
```

## Опціонально: Увімкнення транскрипції

Додайте накладання транскрипції (потребує 4+ ГБ оперативної пам'яті):

```bash
abra app config hotline.example.com
```

Встановіть:

```env
COMPOSE_FILE=compose.yml:compose.transcription.yml
WHISPER_MODEL=Systran/faster-whisper-base
WHISPER_DEVICE=cpu
```

Потім перерозгорніть:

```bash
abra app deploy hotline.example.com
```

Використовуйте `WHISPER_DEVICE=cuda`, якщо ваш сервер має GPU.

## Оновлення

```bash
abra app upgrade hotline.example.com
```

Це отримує останню версію рецепту та перерозгортає. Дані зберігаються в томах Docker і переживають оновлення.

## Резервне копіювання

### Інтеграція backupbot

Рецепт включає мітки [backupbot](https://docs.coopcloud.tech/backupbot/) для автоматизованого резервного копіювання PostgreSQL та RustFS. Якщо ваш сервер запускає backupbot, резервне копіювання відбувається автоматично.

### Ручне резервне копіювання

Використовуйте вбудований скрипт резервного копіювання:

```bash
# З каталогу рецепту
./pg_backup.sh <stack-name>
./pg_backup.sh <stack-name> /backups    # власний каталог, зберігання 7 днів
```

Або зробіть резервну копію безпосередньо:

```bash
# PostgreSQL
docker exec $(docker ps -q -f name=<stack-name>_db) \
  pg_dump -U llamenos llamenos | gzip > backup-$(date +%Y%m%d).sql.gz

# RustFS (об'єктне сховище)
docker run --rm \
  -v <stack-name>_RustFS-data:/data \
  -v /backups:/backups \
  alpine tar czf /backups/RustFS-$(date +%Y%m%d).tar.gz /data
```

Відновлення PostgreSQL:

```bash
gunzip -c backup-20260101.sql.gz | \
  docker exec -i $(docker ps -q -f name=<stack-name>_db) \
  psql -U llamenos llamenos
```

## Моніторинг

### Перевірки справності

Усі служби мають перевірки справності Docker. Перевірте статус:

```bash
abra app ps hotline.example.com
```

Додаток надає кінцеві точки справності:

```bash
curl https://hotline.example.com/health/ready
# {"status":"ok"}
curl https://hotline.example.com/health/live
# {"status":"ok"}
```

### Журнали

```bash
# Всі служби
abra app logs hotline.example.com

# Конкретна служба
abra app logs hotline.example.com app

# Слідкувати за журналами в реальному часі
abra app logs -f hotline.example.com app

# Слідкувати за всіма службами
abra app logs -f hotline.example.com
```

## Довідник команд abra

| Команда | Опис |
|---------|------|
| `abra app ps hotline.example.com` | Показати запущені контейнери та справність |
| `abra app logs [-f] hotline.example.com [service]` | Переглянути (та слідкувати) журнали |
| `abra app config hotline.example.com` | Редагувати конфігурацію додатка (відкриває `$EDITOR`) |
| `abra app secret ls hotline.example.com` | Список секретів та їхніх версій |
| `abra app secret generate hotline.example.com [name]` | Згенерувати один або всі секрети |
| `abra app deploy hotline.example.com` | Розгорнути (або перерозгорнути) додаток |
| `abra app upgrade hotline.example.com` | Отримати останній рецепт та перерозгорнути |
| `abra app undeploy hotline.example.com` | Зупинити та видалити додаток (дані зберігаються) |
| `abra app run hotline.example.com app -- bun run ...` | Запустити одноразову команду в контейнері додатка |

## Архітектура служб

![Архітектура Co-op Cloud](/diagrams/coopcloud-architecture.svg)

## Усунення несправностей

### Додаток не запускається

```bash
abra app logs hotline.example.com app
abra app ps hotline.example.com
```

Перевірте, чи всі секрети згенеровано:

```bash
abra app secret ls hotline.example.com
```

Відсутні секрети відображаються з порожньою версією. Згенеруйте їх:

```bash
abra app secret generate hotline.example.com
```

### Проблеми з сертифікатами

Traefik обробляє TLS. Перевірте журнали Traefik на вашому сервері:

```bash
docker service logs traefik
```

Переконайтеся, що DNS вашого домену вказує на сервер і порти 80/443 відкриті.

### Помилки підключення до бази даних

Перевірте, чи контейнер додатка може досягти PostgreSQL:

```bash
abra app run hotline.example.com app -- \
  bun -e "const { sql } = await import('bun'); await sql\`SELECT 1\`; console.log('ok')"
```

### Ротація секретів

Якщо секрет скомпрометовано:

1. Збільшіть версію в конфігурації додатка: `abra app config hotline.example.com`
   (наприклад, змініть `SECRET_HMAC_SECRET_VERSION=v2`)
2. Згенеруйте новий секрет: `abra app secret generate hotline.example.com hmac_secret`
3. Перерозгорніть: `abra app deploy hotline.example.com`

### Релей WebSocket не підключається

Події в реальному часі потребують релея WebSocket. Якщо ви бачите помилки WebSocket:

```bash
abra app logs hotline.example.com relay
abra app ps hotline.example.com
```

Переконайтеся, що конфігурація Nginx маршрутизує `/WebSocket` до контейнера релея на порту 7777.

## Наступні кроки

- [Посібник адміністратора](/docs/en/guides/?audience=operator) — налаштування гарячої лінії
- [Огляд самостійного хостингу](/docs/en/deploy/self-hosting) — порівняння варіантів розгортання
- [Розгортання Docker Compose](/docs/en/deploy/docker) — альтернативне розгортання на одному сервері
- [Репозиторій рецепту](https://github.com/rhonda-rodododo/llamenos-template) — вихідний код рецепту Co-op Cloud
- [Документація Co-op Cloud](https://docs.coopcloud.tech/) — дізнайтеся більше про платформу
