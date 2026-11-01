# Provider webhook rejections

## Purpose

Every inbound call reaches the app as a webhook from your telephony provider.
If the app refuses those webhooks, **no call is routed and nothing inside the
app can tell you**: the hub alerting that normally would is behind the same
door. This runbook covers the two Prometheus alerts that watch for that from
outside the app, what each refusal kind means, and the periodic check that
keeps the provider's address list current.

The alerts live in `deploy/ansible/roles/llamenos-prometheus/templates/alert-rules.yml.j2`
and are unit-tested by `deploy/ansible/roles/llamenos-prometheus/tests/check-alert-rules.sh`.
They reach whoever operates the deployment through the Alertmanager receiver.
**They do not notify hub members.**

## What the app counts

All three are instance-wide. None carries a hub, user, caller or address label.

| Series | Meaning |
|---|---|
| `llamenos_telephony_webhook_rejected_total{reason, attribution}` | A provider webhook refused with a 403 before any handler ran |
| `llamenos_calls_inbound_total` | Calls that entered the ringing queue |
| `llamenos_calls_answered_total` | Calls a volunteer answered (first pickup wins) |

Each source network (a /24 for IPv4, a /48 for IPv6) adds to the rejection
counter at most once a minute. The table of sources is in memory, is never
persisted and is never labelled, so no address is stored anywhere.

### `reason`

| Value | Meaning |
|---|---|
| `signature_invalid` | The request failed the provider's signature check. A rotated or mistyped auth token / signing secret looks exactly like this. |
| `ip_not_allowed` | `webhook_ip_allowlists.telephony` is set and the sender is not in it. Always refused. The signature is examined only to name the cause for the hub (a valid one raises `provider_allowlist_stale`: the allowlist is out of date), never to accept. |
| `no_provider` | No telephony provider is configured for the hub the request names. |

### `attribution`

A refusal happens **before authentication**, so anyone on the internet can
cause one. Attribution says how much a refusal can be trusted.

| Value | Meaning |
|---|---|
| `own_account` | All three hold: the sender is inside the provider address allowlist, the provider-filled account identifier is **ours**, and the signature failed. Only our provider, acting for our account, produces this. |
| `unattributed` | Anything else. In particular a forger who knows our (public) account id, and someone sending from their own account at the same provider, whose traffic shares our provider's addresses. |

`own_account` is only ever produced when **both** the address allowlist is on
**and** the provider puts its account identifier in its webhooks. Today that is
Twilio and SignalWire (`AccountSid`), Telnyx (`connection_id`) and Bandwidth
(`accountId`). For Plivo, Vonage and the SIP bridge, and for any deployment with
no allowlist, refusals are `unattributed` and the alerts rely on the
inbound-traffic check below. The same reading classifies the hub's
`provider-auth` incident, so the counter and the incident never disagree about
whether a refusal was our provider's.

## The alerts

There is deliberately **no alert on the raw rejection count**. Anyone can
increment it, so a threshold on it would let an attacker wake you at will and
bury a real outage under noise.

### `WebhookAuthOutage`

Two rules share the name, told apart by the `reason` label.

| `reason` | Fires when | Likely cause |
|---|---|---|
| `own_account` | any `own_account` rejection in the last 15 minutes | Rotated or wrong auth token / signing secret. Pages immediately and does not wait for inbound to stop, because a partial rotation (one number, one subaccount) leaves other traffic flowing. |
| `inbound_flat` | any `unattributed` rejection in the last 30 minutes **and** no calls entered the queue in the last 30 minutes **and** some did in the 30 before that | The two causes below look identical from here. |

For `inbound_flat`, work through both:

1. **Signing secret.** Compare the provider console's current auth token / signing key with the one in the hub's telephony settings.
2. **Provider address allowlist out of date.** If `webhook_ip_allowlists.telephony` is set, the provider may have moved its senders. Compare the list with the provider's current published one (below). In the app log, `Telephony webhook IP not in allowlist` entries from addresses you recognise as the provider confirm it.

Attacker noise during a real outage does not silence the alert, and noise on a
quiet hotline does not raise it: the check is on real inbound traffic, which an
outsider cannot fake or suppress.

> `inbound_flat` resolves by itself once both 30-minute windows are flat, i.e.
> roughly 30 to 60 minutes after the traffic stops. It has paged by then. If you
> have not fixed the cause, check `llamenos_calls_inbound_total` directly.

### `InboundButNoAnswers`

Fires when at least `prometheus_routing_no_answer_min_inbound` calls entered the
queue in the last 30 minutes, **none was answered on any hub**, and that has
held for 5 minutes. It is the cross-hub backstop for when the app still serves
metrics but hub alerting is itself broken.

Check, in order: shift schedules and fallback groups on each hub, the telephony
provider's status, and that volunteers' apps are receiving calls. One caller who
hung up before pickup is enough on a quiet line; raise the minimum if that is
your normal.

## Placeholders: the complete list

A fresh checkout gets working alerts after filling **only** these. Nothing else
is needed, and nothing in the repository names a host, address or account of
any deployment.

| Placeholder | Where | Required | If left unset |
|---|---|---|---|
| Alertmanager receiver: `alert_notification_method` and the variables of the method you pick (`alert_ntfy_url` + `alert_ntfy_topic`, or `alert_smtp_host` + `alert_smtp_to` + credentials, or `alert_webhook_url`) | `deploy/ansible/vars.yml`, see `vars.example.yml` and the `llamenos-alertmanager` role | **Yes** | The role's preflight fails the deploy. It refuses to deploy a receiver that delivers nothing. |
| `metrics_scrape_token` (becomes `METRICS_SCRAPE_TOKEN` in the app) | `deploy/ansible/vars.yml` | **Yes** | Prometheus is refused with a 401, `up{job="llamenos-app"}` stays 0, and `AppDown` fires. |
| `webhook_ip_allowlists.telephony`: the provider's published sender ranges, copied from the provider's own page | `deploy/ansible/vars.yml` | No | No `ip_not_allowed` refusals, and no `own_account` attribution. `inbound_flat` and `InboundButNoAnswers` still work. |
| `prometheus_routing_own_account_window` (15m), `prometheus_routing_traffic_window` (30m), `prometheus_routing_no_answer_min_inbound` (1) | `deploy/ansible/roles/llamenos-prometheus/defaults/main.yml`, override in `vars.yml` | No | The defaults apply. Tune to your call volume: a hotline taking a call a day wants longer windows. |

`check-alert-rules.sh` renders the rule template with **only** the role's
defaults and runs the promtool cases against the result, so a variable a rule
needs without a default fails CI instead of silently rendering nothing.

## Where each provider publishes its sender addresses

Links only. **Do not copy ranges or hostnames into this repository**: they
change, and a stale copy is worse than none. Copy them into your private
`vars.yml` instead.

| Provider | Where to look |
|---|---|
| Twilio | Standard webhooks come from a large, changing range, so an allowlist is not practical; the signature is the control. Fixed addresses exist only through [Static Proxy for Webhooks](https://www.twilio.com/docs/iam/twilio-editions/twilio-static-proxy) (Security and Enterprise editions). |
| SignalWire | [Allow SignalWire IPs through your firewall](https://signalwire.com/docs/platform/allow-signalwire-ips-through-your-firewall). It publishes domains to resolve rather than a static list. |
| Telnyx | [IP whitelisting](https://developers.telnyx.com/docs/voice/sip-trunking/network-configuration/ip-whitelisting) (webhook source ranges). |
| Plivo | [Firewall and network configuration](https://docs.plivo.com/docs/voice/concepts/firewall-network-configuration) (callback addresses). Plivo offers change notices by email. |
| Vonage | [Which IP addresses should I allow for the Vonage API services](https://api.support.vonage.com/hc/en-us/articles/16567926552860-Which-IP-addresses-should-I-allow-for-the-Vonage-API-services) |
| Bandwidth | Ask Bandwidth support or see the voice section of its developer documentation; no stable page is linked here. |
| Asterisk / FreeSWITCH (`sip-bridge`) | The "provider address" is the bridge's own address, which you operate. |

If a provider does not publish sender addresses, leave its allowlist unset and
rely on the signature.

## Periodic re-check

An allowlist is a copy of something the provider controls. Re-check it:

- **Owner:** the holders of `telephony:manage-providers` in each hub.
- **Cadence:** monthly, and whenever a provider announces an address change.
- **Task:** open the provider page above, compare it with `webhook_ip_allowlists.telephony`, and update `vars.yml` and redeploy if they differ.

No automated comparison ships with this change. Providers publish these lists
as web pages, not machine-readable files; a provider that adds one can be wired
in as a scheduled check whose URL comes from deploy-time configuration, never
from the repository. Until then `inbound_flat` is the backstop: it fires within
one traffic window of the first real call the stale list turns away.

## Verifying the alerts

```bash
deploy/ansible/roles/llamenos-prometheus/tests/check-alert-rules.sh
```

It needs Docker and `python3` with `jinja2` and `pyyaml`. The cases cover: 500
forged webhooks with healthy traffic (silent), one `own_account` rejection
(fires), attacker noise during a real outage (still fires), noise on a quiet
hotline (silent), and unanswered inbound calls (fires) versus answered ones
(silent).
