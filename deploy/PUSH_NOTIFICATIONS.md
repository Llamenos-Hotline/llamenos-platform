# Android push: self-hosted ntfy / UnifiedPush

## Transport decision — do not reintroduce FCM

Android incoming-call wake-ups are delivered over **UnifiedPush through a
self-hosted [ntfy](https://ntfy.sh) relay that we run ourselves**
(`roles/llamenos-ntfy`). There is **no FCM** (Firebase Cloud Messaging / Google
Play Services push) path, and none may be added: FCM hands notification
metadata (who is being woken, when, how often) to a third party, which
violates the project's zero-knowledge / no-third-party-notification-metadata
constraint. If a future change proposes an FCM fallback "for reliability",
the answer is no — fix the relay instead. (Background: #759, #955.)

Consequences that follow from this decision:

- A backend without a reachable relay **cannot wake an Android device at
  all**. The worker only logs "Android push notifications disabled"
  (`apps/worker/lib/config.ts`) and skips ntfy dispatch silently, so a
  missing relay looks healthy from every other probe. That is why the
  checks below exist.
- Testers must run the **ntfy** UnifiedPush distributor app and point it at
  **our** relay (see "Tester setup").

## Staging: the relay is mandatory

The staging backend is an ordinary deployment with `app_environment: staging`
(see `docs/deploy/staging.md`). Its vars file (vault-encrypted, not checked in)
must set:

```yaml
llamenos_ntfy_enabled: true
# Public name Android devices subscribe through. Must be a subdomain of the
# pinned domain (llamenos-hotline.org for the official build) with a real DNS
# record and a valid TLS certificate, reachable from testers' phones (same
# constraint as the staging host itself, #726 / #954).
ntfy_domain: "push.<staging host>.llamenos-hotline.org"
# Leave ntfy_auth_token unset: the role mints it with `ntfy token add` on
# first deploy and persists it on the host.
```

`ntfy_domain` must be a real public hostname with DNS and TLS. Deploy order in
`playbooks/deploy.yml`: `roles/llamenos-ntfy` runs in the infrastructure play,
before `roles/llamenos-app`, because it is what mints the publish account and
bearer token the app `.env` then carries as `NTFY_URL` / `NTFY_AUTH_TOKEN`.
Caddy serves `ntfy_domain` alongside the app hostname.

A guard that refused to deploy without the relay lived in
`playbooks/deploy-demo.yml` and went with demo mode in #1604; the end-to-end
verification below moved into `playbooks/deploy.yml` and still fails the run.

## Verification (all fail loudly — none can report green with ntfy down)

1. **At deploy time** — at the end of every `deploy.yml` run where
   `llamenos_ntfy_enabled` is true,
   `playbooks/tasks/verify-ntfy.yml` checks from the Ansible control node
   (i.e. from outside the host, over public DNS + TLS):
   - `https://<ntfy_domain>/v1/health` → 200 and `healthy: true`;
   - an anonymous publish is rejected (401/403, deny-all default);
   - a publish with the app's `NTFY_AUTH_TOKEN` succeeds — proves the token
     in the app env matches ntfy's auth config;
   - an anonymous subscriber polling that topic receives the message.
2. **On the host** — `playbooks/smoke-check.yml` probes
   `http://localhost:2586/v1/health` whenever `llamenos_ntfy_enabled` is true.
3. **Continuously** — `.github/workflows/verify-release-live.yml`
   (staging-backend job) requests `<STAGING_NTFY_URL>/v1/health` every 6
   hours and on demand. It **fails** if the repository variable
   `STAGING_NTFY_URL` is unset, or the relay is unreachable or not healthy.
   Set the variable to `https://<ntfy_domain>` when the staging host exists.

Manual spot check from any machine:

```bash
curl -i https://<ntfy_domain>/v1/health     # expect HTTP 200, {"healthy":true}
```

## Tester setup (Android)

Push works only if the tester's phone subscribes to **our** relay:

1. Install the **ntfy** app (F-Droid or Play Store) — it is the UnifiedPush
   distributor.
2. In the ntfy app: Settings → *Default server* → set it to
   `https://<ntfy_domain>` (the staging relay). **Do not use the default
   `ntfy.sh` server** — it is a third-party public service and topic
   metadata would leave our control (#960 covers backend-side allow-listing
   of endpoints).
3. In the Llámenos app, select ntfy as the UnifiedPush distributor and
   register. (Client-side registration is tracked in #955.)

The tester guide (#735) should carry these same steps; the copy of them in
this file is the source of truth for the server hostname requirement.
