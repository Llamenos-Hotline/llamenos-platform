---
title: Початок роботи
description: Розгорніть власну гарячу лінію Llamenos за лічені хвилини.
---

Запустіть гарячу лінію Llamenos локально або на сервері. Потрібен лише Docker — жодних Node.js, Bun або інших середовищ виконання на хості.

## Як це працює

Коли хтось телефонує на номер вашої гарячої лінії, Llamenos маршрутизує дзвінок усім черговим користувачам одночасно. Перший користувач, який відповість, під'єднується, а інші припиняють отримувати дзвінок. Після завершення дзвінка користувач може зберегти зашифровані нотатки про розмову.

![Маршрутизація дзвінків](/diagrams/call-routing.svg)

Та ж маршрутизація застосовується до SMS, WhatsApp, Signal та інших каналів обміну повідомленнями — вони відображаються в єдиному перегляді **Розмови**.

## Передумови

- [Docker](https://docs.docker.com/get-docker/) з Docker Compose v2
- `openssl` (попередньо встановлено на більшості систем Linux та macOS)
- Git

## Швидкий старт

```bash
git clone https://github.com/rhonda-rodododo/llamenos-platform.git
cd llamenos-platform
./scripts/docker-setup.sh
```

Це генерує всі необхідні секрети, збирає додаток та запускає служби. Після завершення відвідайте **http://localhost:8000** і дотримуйтесь інструкцій майстра налаштування:

1. **Створіть обліковий запис адміністратора** — встановіть відображуване ім'я та PIN-код
2. **Назвіть свою гарячу лінію** — встановіть назву, яка відображатиметься в додатку
3. **Виберіть канали** — увімкніть голосовий зв'язок, SMS, WhatsApp, Signal та/або звіти
4. **Налаштуйте провайдерів** — введіть облікові дані для кожного увімкненого каналу
5. **Перевірте та завершіть**

## Продуктивне розгортання

Для сервера з реальним доменом та автоматичним TLS:

```bash
./scripts/docker-setup.sh --domain hotline.yourorg.com --email admin@yourorg.com
```

Caddy автоматично забезпечує сертифікати TLS від Let's Encrypt. Переконайтеся, що порти 80 і 443 відкриті. Прапорець `--domain` активує продуктивне накладання Docker Compose, яке додає TLS, ротацію журналів та обмеження ресурсів.

Перегляньте [Посібник з розгортання Docker Compose](/docs/en/deploy/docker) для повної інформації про посилення безпеки сервера, резервне копіювання, моніторинг та додаткові служби.

## Основні служби

Налаштування Docker запускає ці основні служби:

| Служба | Призначення | Порт |
|--------|-------------|------|
| **app** | Додаток Llamenos (Bun) | 3000 (внутрішній) |
| **postgres** | База даних PostgreSQL | 5432 (внутрішній) |
| **caddy** | Зворотний проксі + автоматичний TLS | 8000 (локальний), 80/443 (продуктивний) |
| **RustFS** | S3-сумісне файлове сховище | 9000 (внутрішній) |
| **WebSocket relay** | Релей WebSocket для подій у реальному часі | 7777 (внутрішній) |

Додаткові профілі додають: signal-notifier сайдкар, sip-bridge (Asterisk/FreeSWITCH/Kamailio), Ollama/vLLM інференс, моніторинг Prometheus.

## Зонди справності

Додаток надає дві кінцеві точки справності, які використовуються перевірками Docker health та зондами Kubernetes:

- `GET /health/ready` — повертає 200, коли додаток готовий обслуговувати трафік (БД підключено, міграції застосовано)
- `GET /health/live` — повертає 200, коли процес додатка живий

## Налаштування вебхуків

Після розгортання вкажіть вебхуки вашого телефонного провайдера на URL вашого розгортання:

| Вебхук | URL |
|--------|-----|
| Голос (вхідний) | `https://your-domain/api/telephony/incoming` |
| Голос (статус) | `https://your-domain/api/telephony/status` |
| SMS | `https://your-domain/api/messaging/sms/webhook` |
| WhatsApp | `https://your-domain/api/messaging/whatsapp/webhook` |
| Signal | Перенаправити на `https://your-domain/api/messaging/signal/webhook` |

Інструкції для конкретних провайдерів: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo), [Asterisk](/docs/en/deploy/providers/asterisk), [SMS](/docs/en/deploy/providers/sms), [WhatsApp](/docs/en/deploy/providers/whatsapp), [Signal](/docs/en/deploy/providers/signal).

## Наступні кроки

- [Розгортання Docker Compose](/docs/en/deploy/docker) — повний посібник з продуктивного розгортання, резервного копіювання та моніторингу
- [Розгортання Kubernetes](/docs/en/deploy/kubernetes) — розгортання з Helm
- [Розгортання Co-op Cloud](/docs/en/deploy/coopcloud) — для кооперативних хостингових колективів
- [Телефонні провайдери](/docs/en/deploy/providers/) — порівняння голосових провайдерів
- [Огляд самостійного хостингу](/docs/en/deploy/self-hosting) — порівняння всіх варіантів розгортання
