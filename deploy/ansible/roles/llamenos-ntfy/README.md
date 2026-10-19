# llamenos-ntfy

Stands up a self-hosted [ntfy](https://ntfy.sh) broker used as the
UnifiedPush distributor for the Android app and as the backend's push relay
(closes #717 — see that issue for the fuller "no ntfy service in the Ansible
stack" background, and #716 for the app-side `NTFY_URL`/`NTFY_AUTH_TOKEN`
wiring this role feeds).

> Transport decision, staging requirements, verification and Android tester
> setup live in [`deploy/PUSH_NOTIFICATIONS.md`](../../../PUSH_NOTIFICATIONS.md).
> The token/ACL provisioning in `tasks/provision.yml` and the compose service
> body in `templates/compose/_ntfy-service.j2` are also used by the
> deprecated monolithic role (`roles/llamenos`).

## Why this needs its own role

`deploy/docker/docker-compose.yml` already ships an `ntfy` service behind
the `push` Compose profile, but that file is only used by the plain
`docker compose up` self-hoster path. Ansible-managed deployments render
each service as its own `docker-compose.yml` under
`{{ app_dir }}/services/<name>/` (see `roles/llamenos-signal` for the
closest analogue) — there was no such role for ntfy, so an Ansible-deployed
box never ran a broker at all, and `NTFY_URL` never resolved to anything.

## Enabling it

```yaml
# vars.yml
llamenos_ntfy_enabled: true
ntfy_domain: "push.hotline.example.org"   # public hostname, required
ntfy_auth_token: ""                        # leave empty — see below
```

Add hosts to the `llamenos_ntfy` inventory group if you're splitting
services across machines; an empty/absent group means "every
`llamenos_servers` host," matching every other service role here.

## Running the relay on its own, unencrypted host

The reference deployment puts the relay on a separate host with **no
full-disk encryption** (`llamenos_disk_encrypted: false`; see
[`docs/deployment/first-deploy.md`](../../../../docs/deployment/first-deploy.md),
"Two hosts, two tiers"). The relay is a good fit for that tier — it needs
reachability, and its payloads are HPKE ciphertext — but its *metadata* is
not safe to accumulate: topic + timestamp is a record of which volunteer
device was woken and when, and a client address next to it is a volunteer's
IP. So on such a host:

- **No message cache at rest.** `NTFY_CACHE_FILE` is never set, so ntfy
  caches in memory only. `tasks/guard-no-persistence.yml` fails the play if
  the rendered compose body sets a cache file, attachment cache, web-push
  file, log file or mounts a `server.yml`; after start, the role lists
  `/var/lib/ntfy` and fails unless it holds only `auth.db` (plus its SQLite
  `-wal`/`-shm`).
- **Minimal logs.** `NTFY_LOG_LEVEL=warn` (at INFO ntfy writes a per-minute
  activity counter) and a single 1 MB `json-file` log. Caddy in front of it
  has no access log, and its error log drops client IP/port, `X-Forwarded-For`
  and the URI (the topic) — asserted by `roles/llamenos-caddy` against the
  config Caddy itself adapts.
- **Cross-host publishing.** `roles/service-discovery` points the app
  host's `NTFY_URL` at `https://<ntfy_domain>`, and this role hands the
  minted publish token to the app host(s) (`delegate_facts`), so one
  `deploy.yml` run wires both ends. Ordering still matters: this role runs in
  the infrastructure play, before the app play.

### What this role leaves on disk

| Path | Contents | Why it is acceptable on an unencrypted disk |
|---|---|---|
| `ntfy-data` volume: `auth.db` | the `llamenos-app` user, its token (with last-use time and address — the app host's), the ACL (`llamenos-app` write-only, `everyone` read-only) and a publish counter | A disk holder learns a credential that can only **publish**, until it is rotated. It cannot address anyone with it: publishing needs a device's topic, and no topic, message or subscriber is stored (the cache is in memory; topics are random, high-entropy strings). |
| `{{ app_dir }}/services/ntfy/.publish-token` | the same token, for idempotent re-runs | Same credential as in `auth.db`; no additional exposure. |
| `{{ app_dir }}/services/ntfy/docker-compose.yml` | image, hostname, ACL defaults — no secrets | Public configuration. |

## Rotating the publish token

Devices never hold an ntfy credential (they subscribe anonymously to their
unguessable topic), so rotating the backend's token does not touch them —
no re-registration. Verified against v2.11.0: after rotation the old token
gets `401`, the new one publishes, subscribers are unaffected.

```bash
# on the relay host
docker exec llamenos-ntfy-ntfy-1 ntfy token list llamenos-app   # note the current token
sudo rm /opt/llamenos/services/ntfy/.publish-token

# from deploy/ansible: mints a new token, re-renders the app .env, restarts the app
ansible-playbook playbooks/deploy.yml -i inventory-production.yml \
  -e @vars-production.yml --ask-vault-pass --tags ntfy,app

# on the relay host, once the app publishes with the new token
docker exec llamenos-ntfy-ntfy-1 ntfy token remove llamenos-app <old token>
```

## Auth model

ntfy's server-side access control is a deny-by-default allow-list
(`NTFY_AUTH_DEFAULT_ACCESS=deny-all`), and this role grants exactly two
things:

| Identity | Access | Why |
|---|---|---|
| `{{ ntfy_publish_username }}` (default `llamenos-app`) | write-only on `*` | The backend publishes encrypted wake payloads to arbitrary per-device topics. It never needs to read a topic back. |
| `everyone` (anonymous) | read-only on `*` | UnifiedPush subscribers (the Android app) have no ntfy credential — the topic name itself is the capability (see below). Anonymous *write* is never granted, so an unauthenticated `curl -d ... https://push.example.org/sometopic` gets `403`. |

No other identity exists, `NTFY_ENABLE_SIGNUP=false` and
`NTFY_ENABLE_LOGIN=false` block creating one, and `NTFY_WEB_ROOT=disable`
turns off ntfy's own browser UI — the only surface exposed publicly is the
publish/subscribe API on `ntfy_domain`.

### Why the publish token is generated, not operator-supplied

Every other secret in `vars.yml` (`pg_password`, `hmac_secret`,
`signal_notifier_bearer_token`, ...) is generated by the operator with
`openssl rand -hex 32` and pasted in. That pattern does not work for
`ntfy_auth_token`: ntfy tokens are minted server-side by `ntfy token add`
and cannot be set to an arbitrary pre-chosen value (verified against the
pinned `v2.11.0` CLI — there is no flag or env var for it, unlike
`ntfy user add`, which does accept a chosen password via `NTFY_PASSWORD`).

So this role, on first deploy:
1. Creates the `llamenos-app` user with a throwaway, never-reused password
   (that password only exists to satisfy `ntfy user add`'s prompt; nothing
   authenticates with it afterwards).
2. Runs `ntfy token add llamenos-app` and captures the token ntfy returns.
3. Persists it at `{{ app_dir }}/services/ntfy/.publish-token` (mode 0600)
   so re-running the playbook doesn't mint a second token every time.
4. Exposes it as the `ntfy_auth_token` Ansible fact, which overrides
   whatever is in `vars.yml` for the rest of the play — `roles/llamenos-app`
   reads that fact through the shared `_worker-required-env.j2` template.

This is also why `roles/llamenos-ntfy` **must run before `roles/llamenos-app`**
in `playbooks/deploy.yml` — it does, in the "Deploy infrastructure services"
play, alongside `llamenos-postgres` and `llamenos-rustfs`.

**Recovery:** if the `ntfy-data` Docker volume is ever restored from an
older backup or wiped, delete `{{ app_dir }}/services/ntfy/.publish-token`
on the host before the next deploy — otherwise this role will keep reusing
a token for a user that no longer exists in the restored `auth.db`, and
`ntfy access` will fail.

## Topic names don't leak identity

UnifiedPush topic names are generated client-side by the Android
distributor library as random, high-entropy strings — never a user ID, hub
ID, phone number, or anything else that maps back to an identity. That
satisfies the zero-knowledge posture in the top-level `CLAUDE.md`: even
someone with read access to the broker's topic list (which ntfy doesn't
expose anyway — there is no "list all topics" endpoint) would learn
nothing about who a topic belongs to. What the backend publishes to a topic
is itself HPKE-encrypted ciphertext (see `apps/worker/lib/ntfy-client.ts`)
— ntfy only ever sees opaque bytes and an opaque topic name.

## Networking

- `ntfy` joins `llamenos-internal` (so an app container on the same host
  can reach it at `http://ntfy:80`, matching `ntfy_url`'s default) and
  `llamenos-web` (so `roles/llamenos-caddy` can reverse-proxy `ntfy_domain`
  to it). An app on another host publishes through `https://<ntfy_domain>`.
- A `127.0.0.1`-only port (`llamenos_ntfy_local_port`, default `2586` —
  matching the port `docker-compose.dev.yml` already uses for the same
  image) exists solely for this role's own health check and CLI
  provisioning steps. It is never reachable off-box and needs no firewall
  rule, same as `llamenos-app`'s `127.0.0.1:3000`.
