# Telephony end-to-end: a real call through self-hosted Asterisk

`run-call-e2e.sh` proves that a phone call is actually routed, and that the
caller actually hears what the operator uploaded — not that Asterisk booted. It
starts, in its own compose project (`ll-telephony-e2e`), on one Docker network:

| Service       | Role                                                                  |
|---------------|-----------------------------------------------------------------------|
| `app`         | The shipped app image, built from this tree, with the project's own `postgres` and `rustfs` |
| `asterisk`    | The hotline PBX, with the shipped `asterisk-config/` — and, like a fresh deployment, no SIP trunk |
| `sip-bridge`  | The shipped bridge image (ARI ↔ app webhooks at `http://app:3000`)   |
| `sip-carrier` | A second Asterisk playing the phone network — TEST ONLY (`carrier/`)  |

…then runs `asterisk-call.e2e.ts` against the app's published port:

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
6. **The caller hears the uploaded prompt** — the hub rate-limits to one call a
   minute; the caller's second call is turned away and, with no prompt
   uploaded, hears nothing. The operator's WebM upload is refused; a 2 s 1 kHz
   PCM WAV is accepted. The third call is turned away again, and the carrier's
   recording of what the caller heard (`[caller-hears]` in
   `carrier/extensions.conf`) holds the tone for its whole length: Asterisk
   fetched it from `http://app:3000/api/ivr-audio/rateLimited/en` and the
   bridge let it finish before hanging up. Fails without the media cache
   directory (`asterisk-entrypoint.sh`) or with an immediate hangup.

```sh
deploy/docker/tests/telephony/run-call-e2e.sh                         # needs only Docker and bun
deploy/docker/tests/telephony/run-call-e2e.sh --keep -g 'hears the prompt'   # one scenario; leave the stack up
E2E_ARI_DEBUG=1 deploy/docker/tests/telephony/run-call-e2e.sh --keep   # log every ARI event
```

The first run builds the app image (including the Rust crypto library), which
takes several minutes; later runs reuse Docker's cache.

## What it does not cover

- **Most prompts.** Only an uploaded `rateLimited` prompt is played on this
  path. The Asterisk adapter asks for `connecting`, `captcha`, `holdMusic` and
  `voicemailPrompt`, which are not prompt types an operator can upload, and
  speaks the language menu, which the bridge cannot (it has no speech engine:
  a `speak` is skipped). Those parts of the call are silent.
- **Hold music and the voicemail beep.** The image ships no sound files and
  no music-on-hold class.
- **DTMF input.** The captcha and multi-digit menu paths are covered by the
  bridge's unit tests, not driven over SIP here.
- **Voicemail.** Covered by unit tests only.
- **A real carrier or NAT.** Both PBXs share one Docker network.

## Why the app runs in the stack

Asterisk fetches operator-uploaded prompts from the URL the app hands it,
which is the origin the bridge's webhooks reach (`http://app:3000`). From a
container, a worker on the host is only reachable if the host firewall lets
container traffic in — ufw drops it by default — so a host-run worker can never
serve a prompt to the PBX. Running the shipped image on the compose network is
also what production does, so the app reaches ARI as `http://asterisk:8088`
and the bridge as `http://sip-bridge:3000` without any name mapping.
