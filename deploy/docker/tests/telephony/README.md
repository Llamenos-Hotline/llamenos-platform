# Telephony end-to-end: a real call through the SIP edge and self-hosted Asterisk

`run-call-e2e.sh` proves that a phone call is routed through the same
client-facing Kamailio edge as a deployment, and that the caller hears the
uploaded prompt — not just that Asterisk booted. It starts, in its own compose
project (`ll-telephony-e2e`), on one Docker network:

| Service       | Role                                                                  |
|---------------|-----------------------------------------------------------------------|
| `app`         | The shipped app image, built from this tree, with the project's own `postgres` and `rustfs` |
| `kamailio`    | Client-facing SIP edge; the only published SIP listener |
| `asterisk`    | The hotline PBX, with the shipped `asterisk-config/` — and no published SIP ports |
| `sip-bridge`  | The shipped bridge image (ARI ↔ app webhooks at `http://app:3000`)   |
| `sip-carrier` | A second Asterisk playing the phone network — TEST ONLY (`carrier/`)  |

…then runs `asterisk-call.e2e.ts` against the app's published port:

Every scenario provisions the SIP trunk the way an operator does, through
`POST /api/provider-setup/create-sip-trunk`, which writes it into the PBX over
ARI (astdb, on the `asterisk-db` volume). The simulated caller sends SIP
traffic to Kamailio, which dispatches it to Asterisk; no E2E client can connect
directly to a host-published Asterisk SIP port.

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
   uploaded, hears the generated rate-limit message. The operator's WebM upload
   is refused; a 2 s 1 kHz PCM WAV is accepted. The third call is turned away
   again, and the carrier's recording of what the caller heard (`[caller-hears]`
   in `carrier/extensions.conf`) holds the tone for its whole length, and not
   the generated message: the upload wins. Fails without the media cache
   directory (`asterisk-entrypoint.sh`) or with an immediate hangup.
7. **Uploaded greeting, then hold message** — both uploads are heard, in order,
   before the caller is queued.
8. **Generated menu and prompts (#1347)** — a hub offering Spanish and French,
   with nothing uploaded; a caller from a French number presses nothing. The
   recording holds, in order, the Spanish and French menu options, then the
   French greeting and hold message — each found by normalised cross-correlation
   (`audio-match.ts`) with the exact clip the app serves for it
   (`fetch-speech.ts`, which mints the same signed URL the worker hands the PBX).
9. **Fallback language (#1347)** — the same, from a Philippine number: Tagalog
   has no offline voice, so the caller hears the English greeting and hold
   message.

`audio-match.test.ts` proves the instrument itself: it finds a clip that was
played through µ-law and rejects one that was not.

## The per-volunteer SIP registrar

`run-register-e2e.sh` proves the safe half of #1435 against the same stack
(own compose project `ll-telephony-register-e2e`). It runs two specs.

`kamailio-edge.e2e.ts` (#1688) asserts the SIP edge is **actually up** —
measured at the socket, never in file text: the Kamailio container is running
with zero restarts and answers `kamcmd core.version`; a SIP OPTIONS over UDP
5060, TCP 5060 and TLS 5061 each gets a 200 from Kamailio itself (TLS verified
against the published trust anchor); and a REGISTER through the TLS listener
with an ARI-provisioned credential gets 200 while a wrong secret gets 401.
It replaces a test that asserted the compose file *contained certain strings*
— an assertion a dead edge satisfies, which is how the edge spent its life
down while everything looked configured.

`asterisk-register.e2e.ts`: `/api/telephony/sip-token`
issues a REAL per-volunteer identity — username `vol_<pubkey16>`, a derived
per-endpoint secret, time-limited TURN credentials — and that identity
registers through the client-facing SIP edge against the live PBX:

1. The operator configures the Asterisk provider through the API
   (`sipDomain` is the public registrar host clients REGISTER against).
2. A volunteer fetches `/api/telephony/sip-token`; the worker provisions
   `auth`/`aor`/`endpoint` on the PBX over ARI (the #1327 trunk path) and
   returns the credential plus RFC 8489 TURN credentials.
3. `sip-register.ts` — a minimal SIP REGISTER client — validates Kamailio's
   published trust anchor, answers the digest challenge over TLS, and registers
   through the edge: 200 OK with the issued credential, 401 with a wrong one,
   401 again after the volunteer's account is deleted (the revocation hook
   removes the PJSIP objects; the e2e checks they are gone over ARI).

The app-facing TLS listener (`:5061`) belongs to Kamailio. The PBX TLS
transport remains internal for PBX-side integration; this e2e verifies the
client-facing TLS handshake and registration rather than a direct PBX socket.

```sh
deploy/docker/tests/telephony/run-register-e2e.sh                       # needs only Docker and bun
deploy/docker/tests/telephony/run-register-e2e.sh --keep                # leave the stack up
```

## The Android transport and media layer (#1188)

`run-android-sip-e2e.sh` drives the **production `LinphoneService` on an
emulator** against this same PBX, over **TLS**, and reads the evidence off
Asterisk's own log. It exists because all three defects it covers are invisible
to a unit test: each is decided where liblinphone meets Asterisk, and each
produced a client that believed it was configured correctly.

| Defect | What was wrong | Evidence it is fixed |
|---|---|---|
| TLS trust | The client set no root CA, the edge certificate is self-signed → `tlsv1 alert unknown ca`. | A `200 OK` for a `REGISTER` through Kamailio's TLS listener, with `verifyServerCertificates`/`verifyServerCn` still on; Asterisk receives the forwarded request over its internal UDP transport. |
| SRTP vs DTLS | The client mandated `SRTP`; the endpoint is provisioned `media_encryption: dtls`. Nothing could negotiate. | Asterisk's SDP answer (`UDP/TLS/RTP/SAVPF`, `a=fingerprint`) and `StreamsRunning` with `currentParams.mediaEncryption == DTLS`. |
| ICE dropped | `iceServers` was deserialised and discarded — no STUN, no TURN, no `natPolicy`. | `a=candidate` lines of types beyond `host` in the offer Asterisk logs. |

It also grants the app the runtime `RECORD_AUDIO` permission it now asks a
volunteer for at clock-in — without which a perfectly negotiated call has no
microphone.

How the pieces fit:

* The emulator reaches the host, and only the host, at `10.0.2.2`. So that is
  the configured `sipDomain`, the `TURN_HOST`, **and** a mandatory
  `subjectAltName` on the Kamailio edge certificate — a client verifies the
  hostname as well as the chain.
* The trust anchor is not installed out of band. `/api/telephony/sip-token`
  publishes the SIP edge's certificate (public half only) in its response, and
  that response arrives over the app's own certificate-pinned HTTPS channel.
  The client makes it the *only* root CA for SIP.
* CoTURN runs on **host networking**, because a TURN server on a bridge network
  advertises its container address in the relay candidate — allocation succeeds
  and the candidate is useless, which is exactly the case a symmetric-NAT
  volunteer depends on.
* `extensions.d/e2e-volunteer-echo.conf` is bind-mounted over `/etc/asterisk/extensions.d/`
  and adds one answer-and-echo target to the volunteer dialplan context. The
  PBX answering is the only way to read the AGREED encryption and a nominated
  ICE pair off the PBX rather than off the client, and the echo returns the
  volunteer's own audio so RTP is proven in both directions. Nothing ships in
  `extensions.d/`; a deployment's dialplan is unchanged.

**The INVITE is placed by the test**, through a `coreForTesting()` seam. The
product has no outbound-calling feature, and the inbound INVITE path — the
server dialling a registered volunteer — does not exist yet (#1188). So this
proves the whole layer *beneath* that keystone, on the volunteer↔PBX leg, and
claims nothing about a caller reaching a volunteer.

```sh
deploy/docker/tests/telephony/run-android-sip-e2e.sh                 # boots everything, incl. an emulator
deploy/docker/tests/telephony/run-android-sip-e2e.sh --no-emulator   # use the device already on adb
deploy/docker/tests/telephony/run-android-sip-e2e.sh --keep          # leave the stack and emulator up
```

Logs and the issued credential land in `.android-sip-evidence/` (gitignored).

```sh
deploy/docker/tests/telephony/run-call-e2e.sh                         # needs only Docker and bun
deploy/docker/tests/telephony/run-call-e2e.sh --keep -g 'hears the prompt'   # one scenario; leave the stack up
E2E_ARI_DEBUG=1 deploy/docker/tests/telephony/run-call-e2e.sh --keep   # log every ARI event
```

The first run builds the app image (including the Rust crypto library), which
takes several minutes; later runs reuse Docker's cache.

## What it does not cover

- **FreeSWITCH.** Its adapter plays the same generated-speech URLs through
  mod_httapi, but no FreeSWITCH runs here.
- **Intelligibility.** A clip found in the recording is the clip the app
  synthesised; whether a listener understands it is measured separately
  (#1347: ASR over the G.711 channel), not here.
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
