---
title: စတင်အသုံးပြုခြင်း
description: သင့်ကိုယ်ပိုင် Llamenos ဟော့လိုင်းကို မိနစ်ပိုင်းအတွင်း ဖြန့်ကျက်ပါ။
---

Llamenos ဟော့လိုင်းကို ဒေသခံ သို့မဟုတ် ဆာဗာတစ်ခုတွင် အလုပ်လုပ်ရန် ရယူပါ။ Docker သာ လိုအပ်သည် — host တွင် Node.js၊ Bun သို့မဟုတ် အခြား runtime များ မလိုအပ်ပါ။

## ၎င်းအလုပ်လုပ်ပုံ

တစ်စုံတစ်ဦးက သင့်ဟော့လိုင်းနံပါတ်ကို ခေါ်ဆိုသည့်အခါ Llamenos သည် ခေါ်ဆိုမှုကို အလုပ်ချိန်ရှိသော အသုံးပြုသူအားလုံးထံ တစ်ပြိုင်နက် လမ်းကြောင်းပေးသည်။ ပထမဆုံးဖြေသော အသုံးပြုသူနှင့် ချိတ်ဆက်ပြီး အခြားသူများ၏မြည်သံ ရပ်သွားပါသည်။ ခေါ်ဆိုမှုပြီးဆုံးပြီးနောက် အသုံးပြုသူသည် စကားပြောခန်းအကြောင်း ကုဒ်ဝှက်ထားသော မှတ်စုများကို သိမ်းဆည်းနိုင်ပါသည်။

![Call Routing](/diagrams/call-routing.svg)

တူညီသောလမ်းကြောင်းပေးခြင်းသည် SMS၊ WhatsApp၊ Signal နှင့် အခြားမက်ဆေ့ချ်ပို့သည့်ချန်နယ်များအတွက်လည်း အကျုံးဝင်ပါသည် — ၎င်းတို့သည် ပေါင်းစည်းထားသော **Conversations** မြင်ကွင်းတွင် ပေါ်လာပါသည်။

## လိုအပ်ချက်များ

- Docker Compose v2 ပါရှိသော [Docker](https://docs.docker.com/get-docker/)
- `openssl` (Linux နှင့် macOS အများစုတွင် ကြိုတင်ထည့်သွင်းပြီးသား)
- Git

## အမြန်စတင်ခြင်း

```bash
git clone https://github.com/rhonda-rodododo/llamenos-platform.git
cd llamenos-platform
./scripts/docker-setup.sh
```

၎င်းသည် လိုအပ်သော လျှို့ဝှက်ချက်အားလုံးကို ထုတ်ပေးပြီး၊ အပလီကေးရှင်းကို တည်ဆောက်ကာ ဝန်ဆောင်မှုများကို စတင်ပါသည်။ ပြီးသည်နှင့် **http://localhost:8000** သို့သွားရောက်ပြီး သတ်မှတ်ခြင်းဝီဇာကို လိုက်နာပါ-

၁။ **သင့်အက်ဒ်မင်အကောင့်ကို ဖန်တီးပါ** — ပြသမည့်အမည်နှင့် သင့် PIN ကို သတ်မှတ်ပါ
၂။ **သင့်ဟော့လိုင်းကို အမည်ပေးပါ** — အက်ပ်တွင် ပြသမည့် နာမည်ကို သတ်မှတ်ပါ
၃။ **ချန်နယ်များကို ရွေးချယ်ပါ** — အသံ၊ SMS၊ WhatsApp၊ Signal နှင့်/သို့မဟုတ် အစီရင်ခံစာများကို ဖွင့်ပါ
၄။ **ဝန်ဆောင်မှုပေးသူများကို ပြင်ဆင်ပါ** — ဖွင့်ထားသော ချန်နယ်တစ်ခုစီအတွက် အထောက်အထားများကို ထည့်သွင်းပါ
၅။ **ပြန်လည်သုံးသပ်ပြီး အပြီးသတ်ပါ**

## အသားတင်ဖြန့်ကျက်ခြင်း

အစစ်အမှန်ဒိုမိန်းနှင့် အလိုအလျောက် TLS ပါရှိသော ဆာဗာအတွက်:

```bash
./scripts/docker-setup.sh --domain hotline.yourorg.com --email admin@yourorg.com
```

Caddy သည် Let's Encrypt TLS လက်မှတ်များကို အလိုအလျောက် ထုတ်ပေးပါသည်။ port 80 နှင့် 443 ဖွင့်ထားကြောင်း သေချာပါစေ။ `--domain` အလံသည် အသားတင် Docker Compose အပေါ်လွှာကို သက်ဝင်စေပြီး၊ ၎င်းသည် TLS၊ log လှည့်ခြင်းနှင့် အရင်းအမြစ်ကန့်သတ်ချက်များကို ပေါင်းထည့်ပါသည်။

ဆာဗာခိုင်မာစေခြင်း၊ အရန်သိမ်းခြင်း၊ စောင့်ကြည့်ခြင်းနှင့် ထည့်သွင်းစရာဝန်ဆောင်မှုများအတွက် အပြည့်အစုံကို [Docker Compose ဖြန့်ကျက်လမ်းညွှန်](/docs/en/deploy/docker) တွင် ကြည့်ပါ။

## အဓိကဝန်ဆောင်မှုများ

Docker သတ်မှတ်မှုသည် ဤအဓိကဝန်ဆောင်မှုများကို စတင်ပါသည်-

| ဝန်ဆောင်မှု | ရည်ရွယ်ချက် | Port |
|---|---|---|
| **app** | Llamenos အပလီကေးရှင်း (Bun) | ၃၀၀၀ (အတွင်းပိုင်း) |
| **postgres** | PostgreSQL ဒေတာဘေ့စ် | ၅၄၃၂ (အတွင်းပိုင်း) |
| **caddy** | Reverse proxy + အလိုအလျောက် TLS | ၈၀၀၀ (ဒေသခံ), ၈၀/၄၄၃ (အသားတင်) |
| **RustFS** | S3-compatible ဖိုင်သိုလှောင်မှု | ၉၀၀၀ (အတွင်းပိုင်း) |
| **WebSocket relay** | အချိန်နှင့်တပြေးညီ ဖြစ်ရပ်များအတွက် WebSocket relay | ၇၇၇၇ (အတွင်းပိုင်း) |

ထည့်သွင်းစရာ profile များတွင်: signal-notifier sidecar, sip-bridge (Asterisk/FreeSWITCH/Kamailio), Ollama/vLLM inference, Prometheus စောင့်ကြည့်ခြင်း။

## ကျန်းမာရေးစစ်ဆေးချက်များ

အက်ပ်သည် Docker ကျန်းမာရေးစစ်ဆေးချက်များနှင့် Kubernetes probes များအတွက် အသုံးပြုသော ကျန်းမာရေးအဆုံးမှတ်နှစ်ခုကို ထုတ်ဖော်ပါသည်-

- `GET /health/ready` — အက်ပ်သည် traffic ကို ဝန်ဆောင်မှုပေးရန် အဆင်သင့်ဖြစ်ပါက 200 ကို ပြန်ပေးသည် (DB ချိတ်ဆက်ပြီး၊ migrations လုပ်ပြီးပါက)
- `GET /health/live` — အက်ပ်လုပ်ငန်းစဉ် အသက်ရှင်နေပါက 200 ကို ပြန်ပေးသည်

## Webhook များကို ပြင်ဆင်ပါ

ဖြန့်ကျက်ပြီးနောက်၊ သင့်တယ်လီဖုန်းဝန်ဆောင်မှုပေးသူ၏ webhook များကို သင့်ဖြန့်ကျက်မှု URL သို့ ညွှန်ပြပါ-

| Webhook | URL |
|---|---|
| အသံ (ဝင်လာသော) | `https://your-domain/api/telephony/incoming` |
| အသံ (အခြေအနေ) | `https://your-domain/api/telephony/status` |
| SMS | `https://your-domain/api/messaging/sms/webhook` |
| WhatsApp | `https://your-domain/api/messaging/whatsapp/webhook` |
| Signal | `https://your-domain/api/messaging/signal/webhook` သို့ ထပ်ဆင့်ပို့ပါ |

ဝန်ဆောင်မှုပေးသူအလိုက် သတ်မှတ်ခြင်းအတွက်: [Twilio](/docs/en/deploy/providers/twilio), [SignalWire](/docs/en/deploy/providers/signalwire), [Vonage](/docs/en/deploy/providers/vonage), [Plivo](/docs/en/deploy/providers/plivo), [Asterisk](/docs/en/deploy/providers/asterisk), [SMS](/docs/en/deploy/providers/sms), [WhatsApp](/docs/en/deploy/providers/whatsapp), [Signal](/docs/en/deploy/providers/signal).

## နောက်အဆင့်များ

- [Docker Compose ဖြန့်ကျက်ခြင်း](/docs/en/deploy/docker) — အရန်သိမ်းခြင်းနှင့် စောင့်ကြည့်ခြင်းပါရှိသော အသားတင်ဖြန့်ကျက်လမ်းညွှန်အပြည့်အစုံ
- [Kubernetes ဖြန့်ကျက်ခြင်း](/docs/en/deploy/kubernetes) — Helm ဖြင့် ဖြန့်ကျက်ပါ
- [Co-op Cloud ဖြန့်ကျက်ခြင်း](/docs/en/deploy/coopcloud) — သမဝါယမအိမ်ရှင်အဖွဲ့များအတွက် ဖြန့်ကျက်ပါ
- [တယ်လီဖုန်းဝန်ဆောင်မှုပေးသူများ](/docs/en/deploy/providers/) — အသံဝန်ဆောင်မှုပေးသူများကို နှိုင်းယှဉ်ပါ
- [ကိုယ်တိုင်အိမ်ရှင် ခြုံငုံသုံးသပ်ချက်](/docs/en/deploy/self-hosting) — ဖြန့်ကျက်ရွေးချယ်စရာအားလုံးကို နှိုင်းယှဉ်ပါ
