# Telephony end-to-end: a real call through self-hosted Asterisk

`run-call-e2e.sh` proves that a phone call is actually routed — not that
Asterisk booted. It starts, in its own compose project (`ll-telephony-e2e`):

| Service       | Role                                                                  |
|---------------|-----------------------------------------------------------------------|
| `asterisk`    | The hotline PBX, with the shipped `asterisk-config/` — and, like a fresh deployment, no SIP trunk |
| `sip-bridge`  | The shipped bridge image (ARI ↔ worker webhooks)                     |
| `sip-carrier` | A second Asterisk playing the phone network — TEST ONLY (`carrier/`)  |

…and an isolated worker (`src/server/index.ts`) on its own port and database,
then runs `asterisk-call.e2e.ts`:

Every scenario provisions the SIP trunk the way an operator does, through
`POST /api/provider-setup/create-sip-trunk`, which writes it into the PBX over
ARI (astdb, on the `asterisk-db` volume). Nothing configures a trunk any other way.

1. **Answered call** — provisions a hub, the Asterisk provider, a volunteer and
   the trunk through the API; the carrier dials the hotline over SIP; the worker's IVR and
   queue run over the bridge; the bridge rings the volunteer's number through
   the trunk; the carrier's "phone" answers; the worker accepts the answer and
   the bridge puts both legs in an ARI mixing bridge. Asserts the call is
   `in-progress` and answered by the volunteer, the PBX bridge holds exactly the
   two legs, the call ends `completed` when the volunteer hangs up (and the
   caller is released), the audit log has `callAnswered`/`callEnded`, and the
   worker's own `AsteriskAdapter` fetches a real WAV recording of the call.
2. **Caller hangs up while ringing** — the volunteer's phone never answers; the
   caller hangs up; asserts the call ends `unanswered` with `callMissed`, and no
   volunteer leg is left ringing on either PBX.
3. **No trunk, then a trunk** — with the trunk removed, the carrier's call is
   refused by the PBX and never reaches the worker; once the operator
   provisions the trunk, the carrier's next call is answered.
4. **Restart persistence** — provisions the trunk, restarts the Asterisk
   container, waits for the bridge to reconnect, and routes a call through the
   trunk written before the restart. (Fails if the trunk store is `memory`.)
5. **Registration trunk** — provisions with the username/password the carrier
   issued (`carrier/pjsip.conf`); asserts the carrier holds the hotline's
   registration, then routes a call in to the registered contact and out to the
   volunteer with digest authentication.

```sh
docker compose -f deploy/docker/docker-compose.dev.yml up -d   # Postgres + RustFS
bun scripts/worktree-db.ts use-isolated && PG_PASSWORD=dev bun scripts/worktree-db.ts ensure
(cd packages/crypto && cargo build --release --features server \
  && mkdir -p dist/server && cp target/release/libllamenos_core.so dist/server/)

deploy/docker/tests/telephony/run-call-e2e.sh           # --keep to leave the PBX up
E2E_ARI_DEBUG=1 deploy/docker/tests/telephony/run-call-e2e.sh --keep   # log every ARI event
```

## What it does not cover

- **Audio content.** Prompts are skipped (no TTS engine is configured, and the
  image ships no sound files), so the IVR is silent; the language menu times out
  to the caller's detected language. Media is exercised only as far as the
  recording capturing ~12 s of the bridged call.
- **DTMF input.** The captcha and multi-digit menu paths are covered by the
  bridge's unit tests, not driven over SIP here.
- **Voicemail.** Covered by unit tests only.
- **A real carrier or NAT.** Both PBXs share one Docker network.

## How the host-run worker reaches ARI

The worker is configured with the ARI URL it has in production,
`http://asterisk:8088`. On the host that name does not resolve, so the harness
maps it to `localhost` with `HOSTALIASES`. A loopback URL is not an option: the
provider-setup SSRF guard rightly refuses one.

## Why the bridge runs on the host network here

The worker runs on the host. From a container, `host.docker.internal` only
reaches it if the host firewall lets container traffic in — ufw drops it by
default — so the overlay puts the bridge on the host network instead. The dev
compose (`docker-compose.dev.yml`) keeps the bridge on the Docker network and
maps `host.docker.internal` to the host gateway.
