# Desktop voice — Tier 4 release checklist

Tier 4 cannot be automated in CI (desktop in-app audio spec, §8): NAT behaviour
behind real residential routers, audio quality under load, and how each OS
handles audio devices being plugged in and out only show up on real machines.
Complete this checklist for every release that ships desktop in-app audio
(#1770), on the release-candidate build. Sign and date each line.

Tiers 1–3 come before this one and do not replace it:

- Tier 1: `deploy/docker/tests/telephony/run-register-e2e.sh`. The SIP edge
  accepts a real credential, and the granted expiry respects the cap.
- Tier 2: `deploy/docker/tests/telephony/run-desktop-sip-e2e.sh`. The real
  voice core registers, answers a real call, and carries audio both ways
  through the TURN relay with DTLS-SRTP. It also checks that a crash leaves no
  credential on disk.
- Tier 3: `PLAYWRIGHT_TEST=true bunx playwright test tests/voice-desktop.spec.ts`.
  The webview's call UI works against the IPC mock.

For **each** of Linux, macOS and Windows:

- [ ] Clock in on a hub. The in-app registration shows as active within 10 s.
- [ ] Clock into a second hub. Calls from **both** hubs ring in the app. A ring
      from the hub that is not active is labelled with its own hub, and it does
      not switch the active hub until it is answered.
- [ ] Answer a call in the app on residential broadband and talk for five
      minutes. Both directions stay audible throughout.
- [ ] Answer a call in the app on a network that blocks UDP, so the call must go
      through the relay. The call connects and stays up for five minutes. This
      proves the TURN relay works end to end.
- [ ] Mute and unmute during a call. The caller hears silence, then speech again.
- [ ] Switch the microphone and the speaker during a call from the device
      pickers. Audio follows the choice.
- [ ] Unplug and replug the audio device during a call. Audio either recovers,
      or the app shows an error. Audio must never go silent without one.
- [ ] Lock the app during a shift. The registration drops, and the phone still
      rings, because routing fails open.
- [ ] Clock out of the last hub. The PBX shows the contact gone within one
      registration window (at most 600 s plus the 60 s qualify).
- [ ] Quit the app during a shift, then look in the app's data directory. No
      file holds the SIP password. (`voice-state/` should be empty.)

Signed: ____________  Date: ____  Build: ____  OS: ____
