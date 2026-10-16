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

# Only needed when TEST_HUB_URL is NOT the deployment's own origin — i.e. any
# port-forwarded run. The CORS scenarios assert the deployment's real policy, so
# they need an origin that host's allowlist actually contains. Default is
# `new URL(TEST_HUB_URL).origin`, which for a forward is `http://127.0.0.1:…`
# and is correctly REFUSED — a 403 on the preflight scenario means this is unset.
export TEST_CORS_ORIGIN='https://<the deployment's app origin>'

bun run test:backend:bdd
```

The first three are required; `TEST_CORS_ORIGIN` is required only for a
port-forwarded run. Setting `TEST_HUB_URL` without `DATABASE_URL` is
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

Of the ~75 raw `request.*(…)` calls in step definitions, the ones that opt in
are the ones whose endpoint is behind a limiter the scenario is not asserting:
`/api/auth/me` in `auth.steps.ts` and `error-disclosure.steps.ts` (`strict`
tier, and these scenarios assert an exact `401` body), `/api/provision/*` in
`race-condition.steps.ts`, the `strict`-tier paths in `permission-matrix`'s
unauthenticated examples table, and the files listed in the next section.
Everything else is left as an ordinary caller on purpose — including every call
that asserts the dev surface is refused (`network-security.steps.ts`,
`access-control-epic-e.steps.ts`, `contracts.steps.ts`) and every webhook or
unauthenticated-tier path where the limiter is keyed on a pubkey the request
does not have, and therefore skipped.

### The eight in-route limiters: isolation, not exemption

A previous version of this runbook said two limiters were "not affected, on
purpose" and that the auth brute-force scenarios "still do" assert their
bodies. **Both claims were false on a deployed target**, and they are recorded
here because the second one was measurable and nobody measured it (#1625):

```
POST /api/auth/login ×7, no secret   401×5 429 429  {"error":"Rate limit exceeded"}
POST /api/auth/login ×7, WITH secret 401×5 429 429  {"error":"Too many login attempts..."}
```

The `strict` middleware is 5/min per IP and the in-route `auth-login` counter
is also 5/min, so **without the harness header the middleware wins, at the same
threshold, with the wrong body**. The assertion on `"Too many login attempts"`
could not pass — not flakily, ever. Two scenarios failed on exactly that.

Eight limiters live inside route handlers, use `lib/helpers.ts#checkRateLimit`,
and are enforced for everybody including on `development`:

| Site | Key | Limit |
|---|---|---|
| `routes/auth.ts` | `auth-login` | 5/min |
| `routes/auth.ts` | `auth-bootstrap` | 3/min |
| `routes/invites.ts` | `invite-validate` | 5/min |
| `routes/invites.ts` | `invite-redeem` | 5/min |
| `routes/webauthn.ts` | `webauthn` | 5/min |
| `routes/webauthn.ts` | `webauthn-verify` | 5/min |
| `routes/recovery-group.ts` | `recovery-initiate` | 2/min |
| `routes/security-events.ts` | `security-events-submit` | 5/min |

**None of them is exempt for the harness, and none of them should be.** Each is
a named brute-force control and eight scenarios exist to assert that one of
them fires; an exemption would make the suite's view of all eight vacuous — the
scenarios asserting a 429 would stop seeing one, and the scenarios that merely
trip over a control would lose the ability to tell "bounded" from "absent".

What the harness gets instead is **isolation**. It names the client a request
is from, in `X-Test-Client-Address`, and the limiter buckets on that
(`apps/worker/lib/route-rate-limit.ts`) — so every scenario floods a bucket of
its own while the production threshold still binds inside it. The header is
honoured *only* for a request that already carries the dev surface's shared
secret, so the authority it grants ("choose your bucket") is strictly less than
what the same credential buys one section above (total exemption from the API
rate limiter) and far less than `POST /api/test-reset`. Without the secret the
header is ignored outright and the real address is used, exactly as on
production. `apps/worker/__tests__/unit/route-rate-limit-client.test.ts`
asserts that from all four directions, including that three different named
addresses from a secret-less caller collapse into one bucket.

The step definitions already had the right shape for this: they gave each
scenario its own `simulatedClientIp()` in `X-Forwarded-For`, which works
against a directly reachable dev server and stops working behind Caddy (next
section). They now send it through `harnessClientHeaders()`, which adds the
header the proxy does not rewrite. `tests/dev-surface-secret.ts` is the one
place that builds both.

One limiter genuinely *is* unaffected, and two look like causes and are not:

- the ban/spam controls on inbound calls are not API rate limits at all;
- `routes/provisioning.ts`'s `provision:room:<id>` cap is cross-IP *per room*
  by design, and each scenario makes its own room, so it is already isolated.
  Exempting it would delete the control the concurrency scenario tests;
- `routes/security-events.ts`'s `security-events-admin-alert` is a fixed-key
  global throttle on admin Signal alerts, called fire-and-forget, so it can
  never produce a `429` and no scenario asserts the alert.

### One scenario is not runnable against a deployed target as written

`security/auth-rate-limiting` › *Login rate limit uses unique client buckets*
sends three logins from each of two addresses and expects all six to succeed.
One process cannot be two real callers once Caddy sets the address, so on a
deployed target this can only ever be a claim about the *simulated* client
identities above — which is worth something (it rules out the single global
bucket described below) but is not evidence that two real callers are told
apart. The scenario carries that caveat in its own comment; derivation of the
real address is covered by `lib/client-ip.ts`'s tests and by the Caddy
template. Showing it end to end would need two clients on the proxy network,
and that is not what the scenario is for.

### Per-client buckets on an Ansible-deployed host

Fixed, as of #1606/#1609 — this section used to say it was not, and the
sequence is worth keeping because the wrong half was the obvious one.

`deploy/ansible/templates/env/_worker-required-env.j2` now sets
`TRUST_PROXY_HEADERS=true`, and
`deploy/ansible/roles/llamenos-caddy/templates/caddy.j2` makes that safe: it
SETS `X-Forwarded-For: {remote_host}` rather than appending, and deletes
`CF-Connecting-IP`, `True-Client-IP`, `X-Real-IP`, `X-Client-IP` and
`Forwarded`. `lib/client-ip.ts` reads the right-most `X-Forwarded-For` entry
and never consults `CF-Connecting-IP` at all. So every caller behind the proxy
gets its own bucket from an address it cannot choose, and the per-IP controls
are per-IP again rather than one global bucket.

The consequence for the suite is the one the previous section mis-stated: the
address Caddy produces is the same for every request the harness makes, which
is correct — the harness *is* one client — and is why its per-scenario
isolation has to come from a credentialed header rather than from pretending to
be many addresses.

## Related

- `docs/runbooks/deploy-self-hosted.md` — standing up a self-hosted instance,
  which is the cheapest way to get a disposable target for this.
- `docs/deploy/staging.md` — the staging host's own notes.
- `tests/live/deployment-readiness.spec.ts` — the read-only, non-destructive
  checks an operator runs against a **production** deployment. It asserts the
  dev routes are absent, so it is not the suite to run against an E2E target.
