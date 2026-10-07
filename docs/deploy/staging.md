# Staging (Internal Availability)

**Superseded by #1604.** Issue #718 decided that "the existing demo deployment
*is* the Internal Availability staging backend", with `app_environment: demo`,
`demo_mode: true` and its own `deploy-demo.yml` workflow, inventory and reset
playbook. The operator has since decided there is **no demo mode**: the product
is a secure hosted version plus self-hosting, and nothing else. So there is no
demo deployment to designate.

The staging backend is now an **ordinary deployment with
`app_environment: staging`** — the same `setup.yml` ->
`playbooks/preflight.yml` -> `playbooks/deploy.yml` -> per-service roles that a
real one runs. That is the point: the only thing separating staging from
production is the one variable that says so.

## What a staging backend sets

| Ansible var | Rendered as | Why |
|---|---|---|
| `app_environment: staging` | `ENVIRONMENT=staging` | `staging` and `development` are the only environments on the `/api/test-*` allowlist. `production` is refused first and unconditionally. |
| `dev_routes_enabled: true` | `DEV_ROUTES_ENABLED=true` | The explicit opt-in. A mis-set `app_environment` alone is not enough. |
| `dev_reset_secret: "<64 hex chars>"` | `DEV_RESET_SECRET=…` | Mandatory outside `development`, minimum 32 characters. Generate with `openssl rand -hex 32`. |
| `llamenos_ntfy_enabled: true` | `NTFY_URL` / `NTFY_AUTH_TOKEN` | Android testers are rung through a self-hosted ntfy relay (UnifiedPush, no FCM). Without it an Android device can never be woken for a call. See `deploy/PUSH_NOTIFICATIONS.md`. |

Plus every secret `preflight.yml` requires (`hmac_secret`, `server_secret`,
`pg_password`, `storage_access_key`, `storage_secret_key`) and the admin key
pair — which, for a host the end-to-end suite will point at, must be the
suite's own. `docs/deploy/E2E_AGAINST_A_DEPLOYMENT.md` is the runbook for that
and for the four layers that keep the `/api/test-*` surface off a production
host.

`deploy/scripts/deploy-self-hosted.sh` generates its own database password,
HMAC secret, server secret and storage key and prompts only for domain, ACME
email, server IP and SSH user — so a disposable staging instance needs no
operator-held credential at all. Add the three vars above to the vars file it
writes before the deploy step.

## Resetting a staging instance

`POST /api/test-reset` (or `/api/test-reset-no-admin`) with the
`X-Test-Secret` header. Both are `404` without the three factors above and
without the header, and `production` is refused before either is read.

Two things that used to be here are gone:

- **`playbooks/reset-demo.yml`** — it POSTed `/api/test-reset` against a host
  running `app_environment: demo`, which always answered 404, so it never
  worked (#1133). Deleted with demo mode rather than fixed: a staging host on
  the allowlist answers that route directly.
- **`POST /api/demo/reset`** — the admin-authenticated "wipe everything and
  re-seed the demo dataset" endpoint. Deleted. `POST /api/test-reset` followed
  by `POST /api/test-seed-sample` is the equivalent, on one secret-gated
  surface instead of two.

## Seeded data for testers

`POST /api/test-seed-sample` writes the fixed fictional dataset
(`apps/worker/lib/sample-dataset.ts`) into one hub: 12 calls with encrypted
notes, 3 shifts covering every hour of every day, 8 contacts, 2 cases and a
conversation per configured messaging channel, sealed to a five-account
fictional cast whose signing seeds the server mints per process and hands back
from `GET /api/test-sample-identities`. `DELETE /api/test-seed-sample` removes
the hub and the accounts again.

This is reachable on staging as of #1604. It was not before: the seeding routes
carried a second guard pinned to `ENVIRONMENT=development`, because the same
seeds were also handed to an unauthenticated demo login picker. That picker
went with the mode.

## What still needs a human

- The hostname/DNS record testers will use, and its inventory + vars secrets.
- Capturing the live health/config evidence #718 asks for (routes are mounted
  under `/api` — there is no bare `/health/*`):
  ```bash
  curl -i https://<host>/api/health/ready
  curl -i https://<host>/api/health/live
  curl -i https://<host>/api/config
  ```
- Confirming #655 (production image cannot run migrations or serve HTTP) does
  not affect the image the staging host runs.
