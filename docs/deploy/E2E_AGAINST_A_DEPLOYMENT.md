# Running the end-to-end suite against a deployed instance

The backend BDD suite normally runs against `bun run dev:server` on localhost.
This is how to point it at a **deployed** target instead, so a deploy is
exercised by the same scenarios that gate every PR rather than by a smoke
check.

> **This is for a throwaway staging target only.** The suite's first action is
> `POST /api/test-reset-no-admin`, which wipes every table and deletes the
> admin. Never point it at a host that serves real callers or volunteers. The
> server refuses to make that possible — see [What stops this reaching
> production](#what-stops-this-reaching-production).

## What has to be true on the deployed host

Three deliberate opt-ins on the server
(`apps/worker/lib/dev-surfaces.ts`), plus the admin key pair below:

| Ansible var | Rendered as | Why |
|---|---|---|
| `app_environment: staging` | `ENVIRONMENT=staging` | `staging` and `development` are the only environments on the allowlist. `production` is refused first and unconditionally, and so is anything unrecognised. |
| `dev_routes_enabled: true` | `DEV_ROUTES_ENABLED=true` | The explicit flag. A mis-set `app_environment` alone is not enough. |
| `dev_reset_secret: "<64 hex chars>"` | `DEV_RESET_SECRET=…` | Mandatory outside `development`, minimum 32 characters. A deployed host is reachable, so the surface must carry a credential. Generate with `openssl rand -hex 32`. |

Setting `dev_routes_enabled` on a non-production environment also publishes
PostgreSQL on the host's **loopback interface only**
(`roles/llamenos-postgres/templates/compose/postgres.j2`), and attaches the
database to an extra non-internal bridge. Nothing off the host can connect
either way; you forward it over SSH below.

The extra bridge is there because Docker accepts a `ports:` entry on a
container attached only to an `internal: true` network, records the binding,
installs no DNAT rule, and nothing ever listens — measured on a real deploy of
the deprecated monolithic role, whose network really is internal-only, and the
reason `check-required-env.py` asserts the network as well as the port.
`llamenos-internal`, which the per-service roles use, is a plain bridge today
(`roles/docker/tasks/main.yml`), so the publish works there without it; the
bridge is kept so that hardening `llamenos-internal` cannot silently break
this.

### And a fourth thing: the admin key pair

The suite authenticates as a **fixed** admin identity — the seed in
`tests/global-setup.ts` / `tests/helpers.ts` — so the target's `ADMIN_PUBKEY`
and `ADMIN_DECRYPTION_PUBKEY` must be that seed's public halves. If they are
not, the run gets past `api-bootstrap` and then fails in global setup with
`Admin verification failed: 401`: `POST /api/test-reset` re-seeds the admin from
the **server's** `ADMIN_PUBKEY`, which deletes the identity `api-bootstrap` just
promoted.

Print the pair the harness expects and put it in the target's vars:

```bash
bun -e 'import {deriveAdminKeys} from "./scripts/bootstrap-admin";
import {hexToBytes} from "@shared/encoding";
const k = deriveAdminKeys(hexToBytes(process.env.ADMIN_SEED!));
console.log("admin_pubkey:", k.identityPubkey);
console.log("admin_decryption_pubkey:", k.decryptionPubkey)'
```

This is why the target has to be disposable: it does not have its own admin
identity, it has the suite's. The seed is currently hardcoded in the TypeScript
harness (`scripts/test-backend-bdd.sh` reads `$ADMIN_SEED`, but
`tests/global-setup.ts`, `tests/helpers.ts` and `tests/crypto-helpers.ts` do
not), so a deployment cannot yet keep its own admin and still be tested — making
that one seed configurable end to end is follow-up work.

The usual deploy applies them. Both deployment shapes go through the same
entry point and the same per-service roles — the deployment **profile** is not
the axis here, only `app_environment` is:

```bash
# Self-hosted. Generates its own secrets (database password, HMAC, server
# secret, storage key) and prompts only for domain, ACME email, server IP and
# SSH user — so a disposable test instance needs no operator-held credential.
# Add the three vars above to the vars file it writes before the deploy step.
deploy/scripts/deploy-self-hosted.sh

# Hosted.
deploy/scripts/deploy-official.sh
```

Either way: `setup.yml` -> `playbooks/preflight.yml` (where the guard runs)
-> `playbooks/deploy.yml` -> `llamenos-postgres`, `llamenos-app`,
`llamenos-caddy`, ...

`playbooks/tasks/guard-dev-routes.yml` (imported by `preflight.yml`, which both
deploy paths run) refuses the run outright if any of those are set while
`app_environment` is `production`, or if the secret is too short.

## Running the suite

Two environment variables point the suite at the deployment, and one tunnel
gives it the database.

```bash
# 1. Forward the deployed PostgreSQL to a local port. Keep this running.
#    (Add -L 13000:127.0.0.1:3000 as well if you cannot reach the host's
#    public HTTPS endpoint directly — then use that for TEST_HUB_URL.)
ssh -N -L 15432:127.0.0.1:5432 <deploy-user>@<staging-host>

# 2. In another shell, from the repo root:
export TEST_HUB_URL='https://<staging-host>'
export E2E_TEST_SECRET='<the host's dev_reset_secret>'
export DATABASE_URL='postgresql://llamenos:<pg_password>@127.0.0.1:15432/llamenos'

bun run test:backend:bdd
```

All three are required. Setting `TEST_HUB_URL` without `DATABASE_URL` is
refused before anything runs — see
[The guard](#the-guard-and-why-it-matters-more-here-than-locally).

`DATABASE_URL` carries `PG_PASSWORD` — read it from the vault, never echo it,
never paste it into a shared log.

The run reports `target: https://… (explicit — DATABASE_URL must name ITS
database)` and then, before anything is written, a `db-identity` step that
proves the runner and the server are using the same database.

## Why the database, and not just the API

Sixteen assertions in the suite query PostgreSQL directly
(`tests/db-helpers.ts`), and they do so *because* the API is not the thing
under test: they check that a JSONB column is an object and not a
double-serialized string, that the audit log's SHA-256 chain detects a row
mutated behind the API's back, and that an E2EE note's envelopes have the
right shape at rest. Re-expressing those through the API would delete what
they test, so the suite needs the real connection.

Hence the tunnel. The alternatives were weighed and rejected:

- **API-level assertions in deployed-target mode** — would silently drop the
  only coverage of what the server actually persists.
- **Publishing the database port for everyone** — exposes it on hosts where
  the suite will never run.
- **Assuming a tunnel on a fixed port** — an assumption that holds until it
  doesn't, and then the suite reads the wrong database. `DATABASE_URL` is given
  explicitly instead; the runner refuses to invent one.

## The guard, and why it matters more here than locally

The deployed PostgreSQL publishes no port by default, so a run pointed at a
remote `TEST_HUB_URL` with `DATABASE_URL` unset would resolve a **local**
database and assert against the control node's own data. Every direct-database
assertion would then pass or fail for reasons unrelated to the deployment —
a green suite that proved nothing. (This repo has been bitten by the same
shape before: a Playwright `request` fixture that proxied to `localhost:3000`
while the configured target sat idle.)

Two things make that impossible:

1. `scripts/test-backend-bdd.sh` resolves this machine's worktree database
   only when `TEST_HUB_URL` is **unset** — the one case where the suite and the
   server it assumes agree by construction. The moment the suite is pointed at
   a server, it calls `worktree_db_export --require-explicit`, which **refuses
   to resolve** a database and exits non-zero unless `DATABASE_URL` was given.

   Note what it deliberately does *not* do: sniff the hostname. An SSH forward
   puts a deployment on `127.0.0.1`, which looks local and is not — a hostname
   heuristic would take the local path for the commonest deployed setup there
   is. "Was the suite pointed at something" cannot be wrong in that way, and
   unlike a `--deployed` flag it cannot disagree with the URL.
2. `scripts/check-db-identity.ts` runs as the `db-identity` step before
   `bddgen`, and compares `current_database()` plus the postmaster start time
   on both sides via `GET /api/test-db-identity`. That pair is independent of
   the network path, so a server inside Docker and a runner on the other end of
   an SSH forward compare equal when they share a database and unequal when
   they do not. A mismatch names both and stops the run.

Neither is skippable and neither degrades to a warning. To see the guard work,
point `DATABASE_URL` at a local database while `TEST_HUB_URL` points at the
deployment: the run fails at `db-identity` with `DATABASE MISMATCH` and both
identities printed.

## What stops this reaching production

Four independent layers, in the order a mistake meets them:

1. **`playbooks/tasks/guard-dev-routes.yml`** — the play fails before a single
   file is rendered to the host when `dev_routes_enabled` or
   `dev_reset_secret` is set with `app_environment: production`. Keyed on
   `app_environment` alone, with no reference to demo mode or to the deployment
   profile.
2. **The templates** — `templates/env/_worker-required-env.j2` omits both
   variables under `production`, and the compose templates publish no database
   port. `deploy/ansible/scripts/check-required-env.py` renders both roles in a
   staging and a production scenario from *identical* inputs and fails CI if
   either outcome is wrong, so neither guard can rot unnoticed.
3. **`apps/worker/lib/config.ts`** — a production process configured with any
   of them refuses to start, rather than running with a disabled-but-configured
   backdoor.
4. **`apps/worker/lib/dev-surfaces.ts`** — the router and every `/test-*`
   handler answer `404`, with `production` checked first so no flag can
   override it.

Within the surface itself: every route requires the secret in an
`X-Test-Secret` header, compared in constant time; failures answer `404`
rather than `401`/`403`, so a probe cannot tell a gated route from an absent
one; and `/test-*` requests that do **not** carry the secret are rate-limited
at the webhook tier (300/min per IP), so the secret cannot be guessed — against
a secret of at least 32 characters, that is the length minimum doing the work,
not the bucket size. Requests that *do* carry it are not throttled — the suite
makes hundreds of them, and a control the suite has to be turned off to run is
not a control.

### Why a shared secret and not admin authentication

The two routes the suite needs first are `POST /api/test-reset-no-admin`,
which deletes the admin, and `POST /api/test-promote-admin`, which creates
one. There is no admin session to authenticate with at that point, and there
cannot be: gating them on one is circular. So the credential is a shared
secret, with the length minimum, the constant-time comparison, the strict-tier
throttle on failed probes and the indistinguishable 404 as the compensating
controls — and with the environment allowlist and the explicit flag ensuring
only a host someone deliberately designated as the test target has the surface
at all.

One surface is deliberately *not* opened by any of this: minting the demo
cast's signing seeds (`lib/demo-identities.ts`) and the admin-authenticated
demo reset (`lib/demo-reset-gate.ts`) go through `demoSurfacesEnabled`, which
stays pinned to `ENVIRONMENT=development`. Demo mode is being removed from the
product entirely, and that predicate exists so the removal is the only thing
that ever changes those surfaces — widening them to a test instance on the way
out would be strictly worse than leaving them alone.

## Rate limiting, and why the suite is exempt

The suite's own per-scenario setup is itself API traffic, and on a deployed
target the server is not on `ENVIRONMENT=development`, so until this was
handled the real per-caller limits applied to it: `POST /api/hubs` from the
`workerHub` fixture is on the `write` tier at 30/min per pubkey, and three
parallel Playwright workers share one admin identity. It answered `429`, the
fixture threw, and every step in that scenario then reported `Cannot
destructure property 'admin' of 'getS(...)'`. Measured against a deployed
instance, that single cause accounted for essentially every failure, on both
topologies.

`apps/worker/middleware/rate-limit.ts` therefore exempts a request that
**presents the `/api/test-*` shared secret** in `X-Test-Secret`, via
`lib/dev-surfaces.ts#devSurfaceRequestAuthorized` — the same three factors as
the dev surface itself (environment allowlist, `DEV_ROUTES_ENABLED`, and a
secret of at least 32 characters), plus a constant-time comparison of the
presented value.

The axis is deliberately the **request**, not the host:

- **Not the environment.** Extending the old `ENVIRONMENT === 'development'`
  skip to cover `staging` would un-rate-limit a host that is reachable from the
  internet for every caller on it.
- **Not `devSurfacesEnabled()` alone.** That is a property of the host — "dev
  surfaces are switched on here" — and it is true for every anonymous request
  that arrives. Only "this is the harness" may relax a per-caller control.
- **The secret grants nothing new.** A caller who holds `DEV_RESET_SECRET` can
  already wipe the database through `POST /api/test-reset`. Letting them also
  skip a throttle adds no authority.
- **`production` cannot reach it.** The predicate refuses `production` first and
  unconditionally, and `lib/config.ts` refuses to start a production process
  that has the variables set at all.

An anonymous request to the same staging host is still limited exactly as on
production — that is the property that makes this safe, and
`apps/worker/__tests__/unit/dev-surface-rate-limit-bypass.test.ts` asserts it
from all three directions (harness exempt; no-secret, wrong-secret,
short-secret, flag-off and `Bearer`-only callers limited; `production` limited
even with the right secret).

Because that exemption is per-request, the harness has to **send** the header.
It is attached where the harness builds its own requests —
`tests/api-helpers.ts#authHeaders` (which is every `apiGet`/`apiPost`/… call,
so most of the suite), `tests/steps/fixtures.ts`' two request contexts (where
the `workerHub` fixture lives), and `tests/global-setup.ts`' raw `fetch`es.
`tests/dev-surface-secret.ts` is the one place that resolves it.

It is deliberately **not** a project-wide `extraHTTPHeaders` in
`playwright.config.ts`, which would have covered the ~70 raw `request.post(…)`
calls in step definitions in one line. Some of those scenarios exist precisely
to prove the credential is *required* — "Dev test-reset rejects requests
without X-Test-Secret header" — and a project-wide default hands it to them
too. Measured on the deployed target: that scenario got `200` instead of `404`,
meaning `POST /api/test-reset` actually ran and wiped the database halfway
through the suite, taking five unrelated scenarios in other workers down with
it (`Failed to delete hub: 401`). Forgetting to opt *in* costs a visible `429`;
forgetting to opt *out* costs a destroyed database and a security assertion
that passes while asserting nothing. So the default is an ordinary caller.

Two limiters are *not* affected, on purpose:

- the per-endpoint brute-force counters inside `routes/auth.ts`
  (`/auth/login`, `/auth/bootstrap`) and the WebAuthn equivalents, which use
  `lib/helpers.ts#checkRateLimit` and are always enforced. The scenarios in
  `packages/test-specs/features/security/auth-rate-limiting.feature` assert
  those, and they still do. (They were, in fact, *un*runnable against a staging
  target before this change: the `strict`-tier middleware 429'd first with the
  wrong body, so the assertion on `"Too many login attempts"` could not pass.)
- the ban/spam controls on inbound calls, which are not API rate limits at all.

### What this does *not* fix: per-IP buckets on an Ansible-deployed host

`TRUST_PROXY_HEADERS=true` is set by `scripts/dev-bun.sh` and by
`deploy/docker/docker-compose.production.yml`, and by **nothing in
`deploy/ansible/`** — which is the path both surviving deployment profiles take.
So on an Ansible-deployed instance `lib/client-ip.ts` ignores the
`X-Forwarded-For` Caddy sets and falls back to the socket address, which is
Caddy's container address for *every* caller.

Two consequences. For the suite: the step definitions give each scenario its
own `CF-Connecting-IP` so that parallel scenarios get their own buckets, and on
a deployed target that header is ignored, so all three workers share one
5/min bucket on each per-endpoint limiter inside the route handlers (invites,
WebAuthn, recovery-group, auth, security-events). Those limiters are *not*
affected by the exemption above, by design, and they account for 22 of the
remaining failures. Verified directly: three requests with three different
`CF-Connecting-IP` values all answered `429` from one shared bucket.

For production, the same omission means the per-IP controls behind Caddy are
in fact a single global bucket — five logins a minute for the whole internet.
It is not fixed here because the fix is not a one-liner: `getClientIp()`
returns a client-supplied `CF-Connecting-IP` verbatim when proxy headers are
trusted, and this deployment has no Cloudflare in front (TLS terminates on the
origin host), so simply setting the variable would let any caller choose their
own bucket. Caddy must strip the forwarded-for headers it does not set — or
`getClientIp()` must stop honouring `CF-Connecting-IP` outside a Cloudflare
deployment — before the variable is turned on.

## Related

- `docs/runbooks/deploy-self-hosted.md` — standing up a self-hosted instance,
  which is the cheapest way to get a disposable target for this.
- `docs/deploy/staging.md` — the staging host's own notes.
- `tests/live/deployment-readiness.spec.ts` — the read-only, non-destructive
  checks an operator runs against a **production** deployment. It asserts the
  dev routes are absent, so it is not the suite to run against an E2E target.
