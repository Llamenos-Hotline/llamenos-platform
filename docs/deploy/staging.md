# Staging (Internal Availability)

Decision for issue #718: **the existing demo deployment *is* the Internal
Availability staging backend.** No separate `staging` deployment profile,
inventory, or workflow is added. This is option (a) from #718 — see the
issue for the full option comparison; the short version is that a third
environment would duplicate the demo host's existing workflow, inventory
secret, vault, SSH key, and reset playbook for no benefit at this milestone,
and the demo host's "test data, can be wiped" semantics are exactly what an
internal tester should expect.

## What "demo is staging" means concretely

- **Hostname**: whatever hostname the `demo` inventory group already points
  at (`deploy/ansible/inventory-demo.yml`, populated from the
  `DEMO_INVENTORY_YML` GitHub secret — this repo does not check in a real
  hostname; a human with access to that secret must fill this section in
  with the actual value once decided).
- **`ENVIRONMENT`**: `demo` (rendered from `app_environment: demo` in
  `demo_vars.yml`), **not** `production` and **not** `development`.
- **`DEMO_MODE`**: `true`, with `demo_mode_confirm: "DESTROY_ALL_DATA"` set
  alongside it (see issue #716 — this is a two-factor confirmation
  `apps/worker/lib/config.ts` requires at startup before it will run
  scheduled data resets; both the app and an Ansible preflight assert
  refuse to start/deploy without it).
- The banner shown to testers is decided separately in issue #733.

## How to (re)deploy it

The demo/staging instance deploys via
`ansible-playbook playbooks/deploy-demo.yml`, driven by the
`Deploy Demo` GitHub Actions workflow
(`.github/workflows/deploy-demo.yml`, `workflow_dispatch` only). That
workflow writes the `DEMO_INVENTORY_YML`, `DEMO_VARS_YML_ENCRYPTED`,
`ANSIBLE_VAULT_PASSWORD` and `DEMO_SSH_PRIVATE_KEY` secrets to disk and
runs the playbook — no manual steps beyond triggering the workflow and
approving the `demo` GitHub environment.

To redeploy by hand against the same inventory:

```bash
cd deploy/ansible
ansible-playbook playbooks/deploy-demo.yml --ask-vault-pass
# or, with a non-default vars file:
ansible-playbook playbooks/deploy-demo.yml --ask-vault-pass -e demo_vars_file=../demo_vars.yml
```

`demo_vars.yml` (vault-encrypted, not checked in) must set at minimum:

```yaml
app_environment: demo
demo_mode: true
demo_mode_confirm: "DESTROY_ALL_DATA"
domain: <the staging hostname>
# ...plus every other secret preflight.yml requires (hmac_secret,
# server_secret, pg_password, storage_access_key, storage_secret_key)
```

Every `demo_vars.yml` run is checked by
`deploy/ansible/playbooks/tasks/guard-demo-mode.yml` (included from both
`preflight.yml` and `deploy-demo.yml`) before anything is rendered to disk:
it refuses to proceed if `demo_mode`, `dev_routes_enabled` or
`dev_reset_secret` are set while `app_environment` is `production`, and it
refuses to proceed if `demo_mode` is true without the exact
`demo_mode_confirm: "DESTROY_ALL_DATA"` two-factor value.

## The `/api/test-*` surface on a non-production instance

`devGuard` (`apps/worker/app.ts`, via `apps/worker/lib/dev-surfaces.ts`) is no
longer pinned to `ENVIRONMENT=development`. It admits `staging` as well,
provided `DEV_ROUTES_ENABLED=true` **and** a `DEV_RESET_SECRET` of at least 32
characters are also set — three factors, all explicit. That is what makes the
end-to-end suite runnable against a deployment; see
`docs/deploy/E2E_AGAINST_A_DEPLOYMENT.md` for the runbook and for the four
layers that keep it off a production host.

The axis is `app_environment`, not the deployment profile: the hosted shape
(`deploy/scripts/deploy-official.sh`) and the self-hosted shape
(`deploy/scripts/deploy-self-hosted.sh`) both run `setup.yml` ->
`playbooks/deploy.yml` -> the same per-service roles, so only
`app_environment` says whether an instance is production.

`demo` is **not** on that allowlist, and demo mode is being removed from the
product altogether. Two consequences while it still exists:

- `playbooks/reset-demo.yml` POSTs `/api/test-reset`, which a host running
  `app_environment: demo` still answers 404. The endpoint that exists for such
  a host is the admin-authenticated `POST /api/demo/reset`
  (`apps/worker/routes/demo.ts`), and that playbook has never been pointed at
  it. Tracked as **#1133**; not fixed here, and moot once the demo path goes.
- `POST /api/demo/reset` is itself still pinned to `ENVIRONMENT=development`
  (`demoSurfacesEnabled`), because it mints and registers the demo cast's
  signing seeds. That pin is deliberately unchanged: the staging allowlist must
  not hand signing material to a deployed host as a side effect.

An operator who needs an on-demand reset on a deployed instance today runs it
as `app_environment: staging` with the `dev_routes_enabled` +
`dev_reset_secret` pair set, and resets through `/api/test-reset`.

## What's still needs-human here

- The actual hostname/DNS record testers will use.
- Filling in `DEMO_INVENTORY_YML` / `DEMO_VARS_YML_ENCRYPTED` with real
  values including `app_environment: demo` and `demo_mode: true` (today's
  content is unknown to this change — this PR does not have access to the
  live secrets and cannot confirm what the current demo host runs).
- Triggering the `Deploy Demo` workflow and capturing the live health/config
  evidence issue #718 asks for (routes are mounted under `/api` —
  `apps/worker/app.ts` does `app.route('/api', api)` and
  `api.route('/health', healthRoutes)` — there is no bare `/health/*`):
  ```bash
  curl -i https://<host>/api/health/ready
  curl -i https://<host>/api/health/live
  curl -i https://<host>/api/config
  ```
- Confirming issue #655 (production image cannot run migrations or serve
  HTTP) does not affect whatever image the demo host currently runs — this
  PR does not change the Docker image and cannot verify that independently.
