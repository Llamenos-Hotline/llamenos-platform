# Telephony provider retention audit

Sourced comparison of what each voice provider **keeps** (recordings, transcripts, call logs, message
bodies) and what its API **lets us delete**, plus what that means for the encrypted stack we run
ourselves. Closes #2310 (operator decision C8). Input to #2309 (delete provider-held media and logs
"wherever possible").

- **Researched:** 2026-10-29, against the providers' live documentation. **Citations hardened the
  same day** (second pass, below). Nothing here was tested against a live account; no credentials
  were used. Every page cited was retrieved on 2026-10-29 unless the line gives another date.
- **Scope:** the 8 voice providers behind `TelephonyAdapter` (Twilio, SignalWire, Vonage, Plivo,
  Telnyx, Bandwidth, Asterisk, FreeSWITCH) and the three `sip-bridge/` PBX backends (ARI, ESL,
  Kamailio). Message bodies are covered where the provider also sells messaging.
- **Rule used throughout:** a claim carries a link to the provider's own page. If I could not find
  it in the provider's documentation it says **undocumented**, with the search I ran. Nothing is
  inferred from a similar provider.

## How to read the evidence tags

| Tag | Meaning |
|---|---|
| **[doc]** | Stated on the provider's official developer documentation page linked in the same line. |
| **[sdk]** | Stated in the provider's *official SDK reference*, which is generated from its API spec (used only where the developer portal page itself was not fetchable). |
| **[support]** | Stated in a provider support/help-centre article. Official, but dated and not versioned with the API — treat as softer than **[doc]**. |
| **[blog]** | Stated only in a provider blog post. Dated by nature; the post date is given inline. (Official changelog entries are treated as **[doc]** but always carry their entry date.) Softer than **[support]**. |
| **unverified** | A figure that appears *only* in a **[support]**, **[sdk]** or **[blog]** source. It is written with its weak source and date **next to the number**, never as a bare figure. Do not state an unverified figure to an operator as fact. |
| **undocumented** | Searched for and not found. The search is recorded in [Gaps and searches](#gaps-and-searches-run). It is *not* evidence the capability is absent or present. |

Where two official pages contradict each other, both are quoted and the row is marked
**contradictory** — do not pick one.

---

## Safe to build on, and what must be `unknown` (for #2309)

Written for the worker implementing deletion and posture reporting. "**Build on**" = the figure
or behaviour is on the provider's *current official developer documentation* (**[doc]**), read
2026-10-29. "**Unknown**" = report `unknown` (or "not documented by the provider") in the posture
report; if you must show a number, show it with its source label and date, as in the table.
**Rule: when two sources disagree, assume the provider keeps the data for the longer period.**

| Provider | Build on (doc, 2026-10-29) | Report `unknown` / show only labelled |
|---|---|---|
| **All cloud** | The delete endpoints and their documented status codes in §3 and §6.2 (existence, not timing). | Anything about provider backups after a delete, except where §3 quotes the provider. |
| **Twilio** | Recording delete → 204, **40-day** metadata residue, no media recovery; call log API window 13 months; `DELETE Calls` does not delete recordings; Voice Insights 30 days (error page); PCI Mode 72 h / 1 year (changelogs, dated 2020 and 2025); message-log default 13 months / 400 days (changelog, 2020-10-14); message bodies ≤30 days in backups after delete. | **Default recording retention** (undocumented — report `unknown`). **Message-log retention is user-configurable 7–400 days** per a 2020 blog only — the setting exists, but do not report a configured value as read from the API. |
| **SignalWire** | Delete endpoints; Media URL Protection off by default (Record-calls guide). | **Every retention figure** (recordings, calls, messages). Reversibility of delete. |
| **Vonage** | Recording auto-delete **30 days** (Call Recording guide — page is undated, so show "per Vonage docs, undated"); CDRs 13 months and server logs 15–30 days (Redact page); Redact API behaviour. | Separate transcript delete; Media-API id mapping to the webhook file id. |
| **Plivo** | **CDR/MDR 90 days** — now on three official pages (§3.4): SMS Reporting page, SIP-trunking Calls API, legacy support export article. Delete recording → 204/404. | **Recording retention**: official pages disagree (30 d vs. 90 d free then billed). Assume **no expiry** — report "provider-documented retention is contradictory; assume indefinite". **Warehouse copies "up to 7 years"**: 2018 blog only; Plivo's own *current* privacy policy (updated 2026-05-27) says it generally retains "all the data that you generate … for seven (7) years after you close your account". Assume **up to 7 years**, label it so. **Message `log` defaults (number 90 d / content 7 d)**: blog dated 2024-06-17; the API reference lists the `log` values but does not define them — show as unverified. |
| **Telnyx** | Recording delete returns the resource and the media "can no longer be downloaded"; recording pre-signed URLs live 10 minutes; `GET /v2/messages/{id}` only works for messages **≤10 days old** (Retrieve-a-message reference); redaction is "not a storage-level deletion". | **Recording retention "1 year"**: one support article only, which itself says the figure "may be subject to change"; no developer-docs page states any recording retention (searched, §Gaps). Report `unknown`, optionally "Telnyx support article says 1 year (read 2026-10-29)". **Message body "wiped after 10 days"**: support article only (page carries no date); the dev docs corroborate only the 10-day *API visibility* window, not erasure. CDR/MDR retention: `unknown`. |
| **Bandwidth** | **Recordings and transcriptions 30 days** (BXML Record page and Recording guide, both **[doc]**); uploaded MMS media "stored for up to 48 hours" (Messaging docs); Bandwidth's dev docs say it "does **not** store any text message content … only metadata". | **Delete purge "24–48 h"**: SDK reference only — show "up to 48 h (SDK reference)". **Call state "7 days"**: SDK reference only — report `unknown`. **Message content**: official pages **contradict** (dev docs: not stored; support article 2026-08-18: "Non-HIPAA A2P message content is stored for 72 hours") — assume the longer, 72 h. Message metadata, billing CDR, *inbound* MMS media: `unknown`. |
| **Asterisk / FreeSWITCH / Kamailio** | Where recordings land and the delete mechanics (§4); they are our host, so retention is whatever we configure. | The SIP trunk carrier's CDRs (always `unknown`). Asterisk CDR/CEL/log defaults (not read). |

---

## 1. Summary matrix

One row per provider, one column per question the issue asked. Every cell is expanded, with links,
in section 3 or 4. The last column is the honest residue.

"Deletable?" below means *the provider documents an API call that removes it*. It does **not** mean
the call is confirmable: only Twilio, Plivo (repeat-delete 404), Telnyx and Bandwidth (access blocked at 204) document
something you can use to check afterwards (see [Confirmability](#52-deletion-confirmability)).

| Provider | Recording: default retention / delete API | Transcription: off-switch / separately deletable | Call logs (CDR) | Message bodies | Account-level switches | **What we cannot remove** |
|---|---|---|---|---|---|---|
| **Twilio** | No automatic expiry documented (outside PCI Mode). `DELETE …/Recordings/{Sid}` → 204. | Opt-in per `<Record transcribe>`. Old Recording Transcriptions API is deprecated but `DELETE` → 204. | `GET` window 13 months. `DELETE …/Calls/{Sid}` removes the record **and not** its recordings/transcripts. | `DELETE` message (bodies persist ≤30 days in backups); `Body=""` redacts; per-message `ContentRetention=discard`. | **PCI Mode** auto-deletes recordings (72 h, or 1 year on accounts created after 2025-09-29). **Voice Recording Encryption** (customer RSA key). Message-log retention, default 400 days (configurable 7–400 days — **[blog]**, 2020). | Recording **metadata for 40 days** after delete; **Voice Insights** call data (30 days, no delete documented); **Monitor Alerts** (webhook request/response bodies, no delete documented); message bodies ≤30 days in backups. |
| **SignalWire** | **Undocumented.** `DELETE …/Recordings/{Sid}` → 204, removes media only. | Transcription resource, `DELETE` → 204. Off-switch **undocumented**. | **Undocumented.** `DELETE …/Calls/{Sid}` → 204. | `DELETE` message, but "Message Logs are read-only history". | **Media URL Protection** is **off by default** for recordings, messages and fax. | **Message Logs** (read-only); retention of anything not yet deleted is **undocumented**; whether deleted media is recoverable is **undocumented**. |
| **Vonage** | **30 days then auto-deleted.** Media API `DELETE /v3/media/{id}` documented for voice recordings. | Opt-in `transcription` in the NCCO `record` action. Separate delete of a transcript: **undocumented**. | CDRs **13 months**, server logs **15–30 days**. Redact API overwrites numbers with `[REDACTED]`. | SMS content etc. redactable via Redact API; CDRs 13 months. | **Redact API** (free, access must be requested); **Standard Auto-Redact** (paid, 7–90-day delay); **Advanced Auto-Redact** (paid, immediate) — *not available for Voice*. | Voice **server logs 15–30 days** (Redact API cannot touch them; Advanced Auto-Redact excludes Voice); CDR rows themselves (only the numbers are overwritten); call **legs** persist until deleted via the Conversation API. |
| **Plivo** | **Contradictory**: Recordings API says free 90 days then billed (no expiry); Record XML page says "deleted after 30 days". `DELETE …/Recording/{id}/` → 204. | Opt-in (`transcriptionType`). `DELETE …/Transcription/{id}/` → 204. | CDR/MDR **90 days** in the live DB (**[doc]**); redacted warehouse copies "up to 7 years" — **unverified** (2018 blog; assume it). | Outbound `log` param exists (**[doc]**); the "number 90 d / content 7 d" defaults are **unverified** (blog, 2024-06-17). Inbound: per-application. | Per-message / per-application `log` setting. | **Warehouse copies of CDR/MDR (assume ≤7 years — unverified, 2018 blog + 2026 privacy policy, last 3 digits masked)**; the 90-day CDR window; the recording-retention contradiction itself. |
| **Telnyx** | **Unverified: "1 year" if not deleted** (support article only, read 2026-10-29; no developer-docs page states a retention). `DELETE /v2/recordings/{id}` and bulk `POST /v2/recordings/actions/delete`. Customer-owned S3/GCS/Azure storage supported. | `transcription` default **false** on `record_start`. `DELETE /v2/recording_transcriptions/{id}`. | **Undocumented** retention. | **Unverified:** body "wiped after 10 days" (support article only); the docs confirm only that the **API** returns messages ≤10 days old. No message-delete endpoint found; opt-in **read-time** redaction. | Messaging-profile `redaction_enabled` (needs allow-listing); data-locality region. | **CDR/MDR retention is undocumented**; message metadata; redaction is "applied at read time" — the docs do not say the stored text is erased. |
| **Bandwidth** | **30 days then deleted** (**[doc]**, two pages). `DELETE …/calls/{callId}/recordings/{recordingId}` (+ `/media`, `/transcription`) → 204, **purge takes a further 24–48 h**. | `transcribe` default **false**; separate transcription delete. | **Unverified:** call state "7 days" (SDK reference only); billing/CDR **undocumented**. | **Contradictory:** dev docs say no text content is stored; support article (2026-08-18) says A2P content 72 h. Uploaded MMS media ≤48 h (**[doc]**). | **Undocumented.** | The 24–48 h purge window (SDK reference); anything about call records (7-day figure unverified); MMS/message *metadata* (undocumented). |
| **Asterisk** (ARI) | On **our** disk: `/var/spool/asterisk/recording` by default. `DELETE /recordings/stored/{name}`. | None built in (we transcribe client-side). | Asterisk CDR/CEL/log files **on our host**; no automatic expiry. | n/a (no messaging). | n/a — we own it. | **The SIP trunk carrier's own CDRs**; Asterisk's own CDR / log files unless we purge them; filesystem remanence and backups. |
| **FreeSWITCH** (ESL) | On **our** disk. No ESL delete command used — the bridge `unlink`s the file itself. | None built in. | `mod_cdr_csv` is **loaded by default**, writes `caller_id_number` to `Master.csv`, no automatic expiry. | n/a | n/a | Same as Asterisk; plus CDR CSV unless `mod_cdr_csv` is unloaded or rotated away. |
| **Kamailio** | **Cannot record** (signalling proxy). | n/a | `acc` module can write to syslog and/or a DB — config-dependent. | n/a | n/a | Whatever `acc` / syslog / the SIP trunk carrier logged. |

---

## 2. Method and limits

- Pages fetched directly from each provider's documentation; where a page was JS-rendered and
  unreadable, an alternative official page or the provider's official SDK reference was used and is
  tagged **[sdk]**.
- Web searches were used to find the right page, never as the evidence itself. Several search-engine
  summaries disagreed with the page they pointed at (for example a Bandwidth support article
  summarised as "48-hour MMS media" actually said "72 hours" for message content and nothing about
  media). Every figure below was re-read on the cited page.
- The pages were read on 2026-10-29. Several provider pages carry no "last updated" date. Re-verify
  before turning a row into a user-facing privacy claim.

---

## 3. Cloud voice providers

### 3.1 Twilio

| Question | Finding |
|---|---|
| Recording storage | Twilio cloud; also external storage possible. No automatic expiry is documented on the Recording resource page — **undocumented** (searched the Recording, Call and Voice Settings pages, and the web for "Twilio recording retention default"). Media is fetchable only while "the Recording's status is `completed`" and stored at Twilio ([Recording resource](https://www.twilio.com/docs/voice/api/recording)). |
| Delete API | `DELETE https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Recordings/{Sid}.json` → **204**. "Only completed recordings can be deleted." The recording status becomes `deleted`; "The metadata is preserved for a period of **40 days**, during which time the metadata is still visible in the Console and API. The recording media cannot be recovered." ([Delete a Recording](https://www.twilio.com/docs/voice/api/recording#delete-a-recording)) |
| Confirmable? | Yes, partly: after delete, media fetch returns Not Found, and `status=deleted` is visible with `IncludeSoftDeleted=true` for the 40-day window ([Recording resource](https://www.twilio.com/docs/voice/api/recording)). |
| Media access control | "Twilio enforces HTTP Basic Authentication for all media URLs" ([Recording resource](https://www.twilio.com/docs/voice/api/recording)). |
| Encryption at rest | All recordings encrypted at rest in Twilio storage by default. With **Voice Recording Encryption**, recordings are encrypted with *your* RSA public key "as soon as the call ends, while the recording is within the Twilio infrastructure, and before it is in cloud storage"; `EncryptionDetails` has `type: rsa-aes`, `public_key_sid`, `encrypted_cek`, `iv` ([Voice Recording Encryption](https://www.twilio.com/docs/voice/tutorials/voice-recording-encryption)). Twilio therefore still handles plaintext during the call and until it ends. |
| Transcription | Recording Transcriptions API is **deprecated** ("use the Batch Transcription API"); only `<Record transcribe="true">` recordings ≤2 minutes are transcribed; paid; `DELETE /2010-04-01/Accounts/{AccountSid}/Transcriptions/{Sid}.json` → 204 ([Recording Transcription](https://www.twilio.com/docs/voice/api/recording-transcription)). Not on unless requested in TwiML. Transcript retention period: **undocumented** on that page. |
| Call logs | Retrievable via `GET /Calls` for **13 months**; older only via Bulk Export ([Call resource](https://www.twilio.com/docs/voice/api/call-resource)). `DELETE …/Calls/{Sid}.json` → 204 deletes the call record and its call events but "will **not** delete associated recordings and transcription records". "For calls less than 13 months old, resources deleted from this endpoint will also be deleted in Log Archives. Calls older than 13 months can only be deleted via the Bulk Export API." ([Delete a Call](https://www.twilio.com/docs/voice/api/call-resource#delete-a-call)) |
| Schema annotation | The Call and Message property schemas carry a `deleteSla` value alongside PII flags (`from`/`to` = 120; message `body` = 30, `transcription_text` = 30). The pages do not define the unit or the meaning. Recorded here as a pointer, **not** as a guarantee. |
| Voice Insights | "Voice Insights only stores 30 days worth of call data" ([error 17002](https://www.twilio.com/docs/api/errors/17002)). No delete operation was found in the Voice Insights pages read — **undocumented**. |
| Debugger / Monitor Alerts | Alert resources hold `request_url`, `request_variables` and `response_body` for failed webhook requests; "queries for alerts older than 30 days are not supported". The page documents no `DELETE` ([Monitor Alerts](https://www.twilio.com/docs/usage/monitor-alert)). A failing webhook that echoes caller data therefore lands in a log we cannot delete. |
| Message bodies | `DELETE …/Messages/{Sid}.json` → 204; "A deleted Message resource no longer appears in your Account's Messaging logs. Deleted messages cannot be recovered"; "Message bodies may persist for up to **30 days** after an HTTP DELETE request in our database backups." Redact in place with `POST … Body=""` ([Message resource](https://www.twilio.com/docs/messaging/api/message-resource)). At send time, `ContentRetention=discard` and `AddressRetention=obfuscate` exist ("based on privacy settings"). |
| Message-log retention | Default: messages viewable/retrievable "for thirteen months after the message is created", shown as a 400-day Data Access Policy; older records remain in backup via Bulk Export, except media older than 13 months **[doc]** ([changelog, 2020-10-14](https://www.twilio.com/en-us/changelog/messaging-data-availability-updated-to-13-months)). That the window is **configurable 7–400 days** is **unverified**: it appears only in a Twilio blog, undated on the page ([New data controls](https://www.twilio.com/en-us/blog/new-data-controls-twilio-messaging), read 2026-10-29), and the changelog does not say customers can change it. Twilio's help-centre storage articles are JS-rendered and were not readable. |
| Message content handling | At send/receive time, per Twilio's redaction guide: unredacted outbound and inbound SMS/MMS/RCS content is "accessible to Twilio's production environments for up to 24 hours", then held in "separate, limited-access storage for compliance purposes"; inbound media is deleted after 24 hours; webhook GET parameters are logged "for up to seven days" ([Message redaction](https://www.twilio.com/docs/messaging/guides/privacy-message-redaction)). The compliance-storage period is **undocumented**. |
| Account-level switches | **PCI Mode**: with PCI Mode + Voice Recording Encryption on, "Call Recordings will only be stored by Twilio for **72 hours** … Once deleted, these recordings will no longer be recoverable by either Twilio Console or API request" ([2020 changelog](https://www.twilio.com/en-us/changelog/payment-card-industry--pci--compliant-voice-recordings)). Accounts created, or PCI Mode enabled, on/after 2025-09-29 "inherit a new recording retention period of **one year**, increased from the current 72 hours"; existing PCI accounts can opt in ([2025 changelog](https://www.twilio.com/en-us/changelog/updates-to-voice-pci-recordings-console-setting-and-retention-policy)). **Native and Marketplace transcription are unavailable under PCI Mode** ([Recording resource](https://www.twilio.com/docs/voice/api/recording)). Nothing documented forces recording *on* at account level. |
| **What we cannot remove** | (1) Recording **metadata** for 40 days after delete. (2) **Voice Insights** call data, 30 days, no delete. (3) **Monitor Alerts** request/response bodies. (4) Message bodies for ≤30 days in backups. (5) Plaintext handling during the call itself, even with Recording Encryption. (6) Anything we already pulled into a Bulk Export file. |

### 3.2 SignalWire

SignalWire's Compatibility (LaML) API mirrors Twilio's shape, but its documentation is **much
thinner on retention**. Nothing about Twilio may be assumed for it.

| Question | Finding |
|---|---|
| Recording storage / retention | Recordings appear under Storage › Recordings in the Space dashboard ([Record calls guide](https://signalwire.com/docs/swml/guides/record-calls)). Default retention: **undocumented** (searched the Compatibility API recording pages, the Record-calls guide, the docs index `llms.txt`, and the web for "SignalWire recording retention"). |
| Delete API | `DELETE https://{space}.signalwire.com/api/laml/2010-04-01/Accounts/{AccountSid}/Recordings/{Sid}` → no body. "This removes the recording media without deleting its call or conference record." Needs the `Voice` scope ([Delete a Recording](https://signalwire.com/docs/compatibility-api/rest/recordings/delete-recording)). Whether the deletion is reversible and whether metadata lingers: **undocumented**. |
| Media access control | Media URLs "aren't access-gated by default"; a Project Configuration setting (**Media URL Protection**: recordings, messages and fax, independently) requires `project_id:api_token` basic auth. "They are all off by default." ([Record calls guide](https://signalwire.com/docs/swml/guides/record-calls)) — this is a *default-public-URL* hazard that Twilio does not share. |
| Transcription | `DELETE …/Transcriptions/{Sid}` → no body; "removes the transcript without deleting its source recording" ([Delete a Recording Transcription](https://signalwire.com/docs/compatibility-api/rest/recording-transcriptions/delete-transcription)). Off-switch per number/account: **undocumented** (the Record guide documents `transcribe` as an opt-in call action). |
| Call logs | `DELETE …/Calls/{Sid}` "removes the record; it does not hang up an active call" ([Delete a Call](https://signalwire.com/docs/compatibility-api/rest/calls/delete-a-call)). Retention window: **undocumented**. |
| Message bodies | `DELETE …/Messages/{Sid}` — "A message still in `queued` status cannot be deleted. This removes the managed message resource; **SignalWire REST Message Logs are read-only history.**" ([Delete a Message](https://signalwire.com/docs/compatibility-api/rest/messages/delete-message)). No redaction call found. Retention: **undocumented**. |
| Account-level switches | Media URL Protection (above). A "Sensitive content" redaction feature exists for AI-agent conversations ([content redaction](https://signalwire.com/docs/platform/ai/content-redaction)); it does not apply to a plain LaML `<Dial record>`. |
| **What we cannot remove** | (1) **Message Logs** — documented as read-only. (2) Whether a deleted recording/call record is recoverable, and for how long: **undocumented**. (3) Any retention of data we have *not* deleted: **undocumented** — we cannot promise an upper bound. |

### 3.3 Vonage

| Question | Finding |
|---|---|
| Recording storage / retention | "After your recording is complete, it is stored by Vonage for **30 days** before being automatically deleted" ([Call Recording guide](https://developer.vonage.com/en/voice/voice-api/guides/recording)). The page is old; re-confirm before quoting externally. |
| Delete API | The Redact page states a call recording "will create a media resource … This can be deleted using the DELETE method of the Delete a Media Item endpoint": `DELETE https://api.nexmo.com/v3/media/{id}`, Bearer-JWT *or* Basic auth ([Redact: Voice API section](https://developer.vonage.com/en/redact/technical-details), [Media API](https://developer.vonage.com/en/api/media)). The Media API page documents only "Successfully deleted" (no status code, no retention, no recovery statement). **Undocumented:** that the `api.nexmo.com/v1/files/{uuid}` URL delivered in the recording webhook carries the same id the Media API expects. Do not assume it. |
| Download auth | "You will need to authenticate with a **JWT signed by the same application key** that created the recording" ([Call Recording guide](https://developer.vonage.com/en/voice/voice-api/guides/recording)). |
| Transcription | Opt-in `"transcription": {}` inside the NCCO `record` action; chargeable; 2-hour maximum; result is a webhook with a `transcription_url` fetched with the same JWT. Deleting a transcript separately: **undocumented** (searched the Voice, Media and Redact pages). |
| Call logs | "Server logs are retained between **15 and 30 days** while the CDRs are stored for **13 months**." ([Redact your data](https://developer.vonage.com/en/redact/technical-details)). Call **legs** are separate resources that "will continue to exist" after a CDR is redacted; delete each with the Conversation API's *Delete Leg* (find them with *List Legs* by `conversationUuid`) — same page. |
| Redaction | **Redact API** `POST https://api.nexmo.com/v1/redact/transaction` with `id` and `product` (`sms`, `voice`, `number-insight`, `verify`, `verify-sdk`, `messages`, …); a 1-hour `premature-redaction` waiting period; 170 req/s ([Redact API reference](https://developer.vonage.com/en/api/redact)). Access must be requested from Vonage support; it is free. "Upon redaction, the real personal data content in the redacted fields is overwritten with the string `[REDACTED]`. Personal data that is redacted is permanently deleted." Voice scope: sender/recipient phone number **in the CDR only** ([Redact your data](https://developer.vonage.com/en/redact/technical-details)). |
| Auto-redact | Standard (paid; delay of 7, 15, 30, 60 or 90 days; redacts CDRs only) and Advanced (paid; immediate; also server logs). **Voice supports Standard only**; Advanced covers SMS, Messages, Verify and Number Insight ([Redact your data](https://developer.vonage.com/en/redact/technical-details)). |
| Message bodies | SMS: content, receiver number and IP are personal data; a data pipeline holds CDRs with numbers for 7 days, server logs 10 days, long-term CDRs 13 months — all redactable only with **Advanced** auto-redact; the free Redact API reaches the 13-month store only ([same page](https://developer.vonage.com/en/redact/technical-details)). |
| **What we cannot remove** | (1) Voice **server logs, 15–30 days** — neither the Redact API nor Advanced Auto-Redact reaches them for Voice. (2) The **CDR row itself** (timestamps, durations, ids); only the numbers are overwritten. (3) Everything Vonage holds before the 1-hour redaction window opens. (4) Transcripts as separate objects: no documented delete. (5) The Redact API requires Vonage to grant access — an operator onboarding step, not something our code can do. |

### 3.4 Plivo

| Question | Finding |
|---|---|
| Recording storage / retention | **Contradictory.** The Recordings API page lists "Storage (first 90 days) Free; after 90 days $0.0004/minute/month" and exposes `recording_storage_duration` — i.e. no expiry ([Recordings API](https://www.plivo.com/docs/voice/api/recording/list-all-recordings), [Download recordings](https://www.plivo.com/docs/voice/use-cases/download-recordings)). The Record XML page says "Download recordings from Plivo; they're deleted after **30 days**" ([Record element](https://www.plivo.com/docs/voice/xml/record)). Two official pages, two behaviours. **Our code must assume the longer reading (no expiry)**; delete explicitly, never rely on expiry. A third page, a Plivo support article ("Does Plivo charge for recording storage?", surfaced by search, JS-rendered and not re-read), is reported to say storage is free for 90 days from 2023-08-31 and billed after — consistent with the 90-day/no-expiry reading, not the 30-day one. None of the three pages is dated; the Record page has no "last updated". |
| Delete API | `DELETE https://api.plivo.com/v1/Account/{auth_id}/Recording/{recording_id}/` → **204**, **404** if absent; "Permanently delete a recording from your account." ([Delete a Recording](https://www.plivo.com/docs/voice/api/recording/delete-a-recording)). Backups/recoverability: **undocumented**. |
| Confirmable? | Partly: the delete page documents 404 for a recording that does not exist, so a repeat delete distinguishes "gone" from "present". Recoverability and backups are undocumented. |
| Recording identifiers | Webhook delivers `RecordUrl` and `RecordingID` ([Record element](https://www.plivo.com/docs/voice/xml/record)); the API list returns `recording_id`, `call_uuid`, `recording_url` ([Recordings API](https://www.plivo.com/docs/voice/api/recording/list-all-recordings)). |
| Transcription | `<Record transcriptionType="auto|hybrid|manual" transcriptionUrl=…>` — opt-in. Transcription API: list / retrieve / create / `DELETE …/Transcription/{transcription_id}/` → 204 ([Recordings API](https://www.plivo.com/docs/voice/api/recording/list-all-recordings)). |
| Call logs, **90 days** | **[doc]**: "You can view data up to 90 days old on the Logs screen. … Plivo doesn't retain data for longer than 90 days." ([Messaging › Reporting](https://www.plivo.com/docs/messaging/concepts/reporting), read 2026-10-29, undated); "You can retrieve only calls from the last 90 days." ([SIP-trunking › List all calls](https://plivo.com/docs/sip-trunking/api/call/get-cdr-of-call), read 2026-10-29, undated). Also repeated in a legacy support article ("Exporting MDR/CDR", ~2018). Note the Reporting page says "doesn't retain … longer than 90 days", which **conflicts with the warehouse claim below**; the page covers console log visibility, so it is not proof of erasure. |
| Call logs, **"up to seven years" warehouse** | **Unverified.** Only source for a *redacted-copy* warehouse is a 2018 blog: "redacted MDRs and CDRs will be persisted in Plivo data warehouses for **up to seven years**. The redacted records have the last three digits of the From and To numbers masked." ([Plivo GDPR update, 2018](https://plivo.com/blog/plivo-gdpr-update-cdr-and-mdr-compliance-done)). Not repeated in any current docs page. Plivo's *current* Privacy Policy (last updated 2026-05-27, read 2026-10-29) says "we generally retain all the data that you generate as part of your relationship with Plivo for seven (7) years after you close your account" unless legal/security requirements say otherwise ([Privacy Policy](https://www.plivo.com/legal/privacy/)) — so a 7-year horizon is **independently plausible** but is a generic account-data statement, not a CDR statement. **Our code should assume up to 7 years and label it unverified.** No CDR delete endpoint was found (searched Plivo docs and web). |
| Message bodies | **[doc]**: the Send-a-Message reference lists a `log` parameter, "Data logging preference", values `true` (default), `false`, `content_only`, `number_only` — it does not define them ([Send a message](https://www.plivo.com/docs/messaging/api/message/send-a-message), read 2026-10-29). **Unverified (blog, 2024-06-17):** default `true` "stores the destination number for 90 days and message content for 7 days"; `false` redacts both (number partially). Inbound is set per application, `true`/`false` only ([Advanced message storage options](https://www.plivo.com/blog/advanced-message-storage-options/)). The 7-day content figure is shorter than the Reporting page's 90-day ceiling, so the two do not conflict, but no docs page confirms it. |
| **What we cannot remove** | (1) **Possible warehouse CDR/MDR copies up to 7 years — unverified** (2018 blog; masked to last three digits, still a linkable number prefix + timing). (2) CDRs for 90 days **[doc]**. (3) The 30-day-vs-90-day recording contradiction (assume the longer). (4) Backups after delete: undocumented. |

### 3.5 Telnyx

| Question | Finding |
|---|---|
| Recording storage / retention | Default: "Call recordings are automatically stored in S3 buckets owned by Telnyx, but users can opt to store recordings in their own S3 or GCS buckets" (Azure shown too) ([Storing call recordings](https://developers.telnyx.com/docs/voice/programmable-voice/storing-call-recordings)). Retention: **unverified.** The only statement is a support article: "Call Recordings are stored for **1 year** if you do not delete them. The 1-year max time may be subject to change." ([Call Recording, support](https://support.telnyx.com/en/articles/5377454-call-recording), read 2026-10-29; the page carries no date and Telnyx itself says the figure may change). Retrieval attempts in the developer docs — [Storing call recordings](https://developers.telnyx.com/docs/voice/programmable-voice/storing-call-recordings), [Retrieve a call recording](https://developers.telnyx.com/api-reference/call-recordings/retrieve-a-call-recording) — found **no retention statement**, and a search of developers.telnyx.com and telnyx.com found none. **Treat retention as `unknown`; if a number must appear, show it as "Telnyx support article: 1 year (unverified)".** |
| Delete API | `DELETE /v2/recordings/{recording_id}` — "Permanently deletes the specified call recording and returns the deleted recording resource. The media is removed and can no longer be downloaded." ([Delete a call recording](https://developers.telnyx.com/api-reference/call-recordings/delete-a-call-recording)). Bulk: `POST /v2/recordings/actions/delete` ([Delete a list](https://developers.telnyx.com/api-reference/call-recordings/delete-a-list-of-call-recordings)). TeXML variant: [Delete recording resource](https://developers.telnyx.com/api-reference/texml-rest-commands/delete-recording-resource). |
| Confirmable? | The delete returns the deleted resource; "can no longer be downloaded". Retrieval after delete is expected to 404 (the retrieve page documents 404) but there is no documented soft-delete window. |
| Download URLs | Webhook URLs are pre-signed S3 links: "The link to the recording is active for **10 minutes**" ([Storing call recordings](https://developers.telnyx.com/docs/voice/programmable-voice/storing-call-recordings)). `GET /v2/recordings/{id}` returns `download_urls.mp3` / `.wav` ([Retrieve a call recording](https://developers.telnyx.com/api-reference/call-recordings/retrieve-a-call-recording)). |
| Transcription | `record_start` option `transcription` — "The default value is false" ([record_start](https://developers.telnyx.com/api-reference/call-commands/recording-start)). `DELETE /v2/recording_transcriptions/{id}` ([Delete a recording transcription](https://developers.telnyx.com/api-reference/call-recordings/delete-a-recording-transcription)). Transcript retention period: **undocumented**. |
| Call logs | CDR/MDR retention period: **undocumented** (searched developer docs, support site, data-privacy page, release notes). Storage *region* is selectable once ([data storage location](https://telnyx.com/release-notes/data-storage-location-portal)). No CDR delete endpoint found. |
| Message bodies | **Unverified (support article, undated):** "For privacy reasons, a message's body text is only stored for up to **10 days** before it is wiped from our system. At that point, the hash fields can be used to identify messages." ([MDR report log, support](https://support.telnyx.com/en/articles/1130611-understand-telnyx-sms-mdr-report-log), read 2026-10-29). The developer docs confirm only a related *API* limit: "This API endpoint can only retrieve messages that are no older than 10 days since their creation" ([Retrieve a message](https://developers.telnyx.com/api-reference/messages/retrieve-a-message), **[doc]**, read 2026-10-29), and the developer [MDR](https://developers.telnyx.com/docs/messaging/messages/message-detail-records) and redaction pages state **no storage retention**. The 10-day API limit is consistent with a 10-day wipe but does not prove one; MDR *report* retention beyond 10 days is **undocumented**. No SMS delete endpoint found (a delete exists only for *email* messages). **Message Redaction**: per messaging profile, "requires activation on the organization" (support allow-list), text/subject/media blanked and the counterparty's last four digits masked; "**Redaction applies at read time**" and "it is not a storage-level deletion of message content" (re-read 2026-10-29); at the default level 2 inbound webhooks are redacted too, at level 1 they are not ([Message redaction](https://developers.telnyx.com/docs/messaging/messages/message-redaction)). |
| **What we cannot remove** | (1) **CDR/MDR** — retention undocumented, no delete; recording retention itself is unverified (above). (2) Message metadata (ids, direction, timestamps, carrier, cost, TCR campaign) is explicitly preserved by redaction. (3) Whether read-time redaction erases the stored text: **the docs say "applies at read time" and never say "erases"** — do not report it as deleted. (4) Pre-signed URLs already minted live out their 10 minutes. |

### 3.6 Bandwidth

| Question | Finding |
|---|---|
| Recording storage / retention | **[doc]**: "Bandwidth will keep recordings for up to **30 days**. After 30 days the recordings will be deleted from Bandwidth's servers." ([`<Record>` BXML](https://dev.bandwidth.com/docs/voice/bxml/record)); "Recordings are stored for 30 days" and "Transcriptions are stored for 30 days" ([Record and transcribe guide](https://dev.bandwidth.com/docs/voice/guides/recording/)). Both read 2026-10-29; neither page is dated. |
| Delete API | `DELETE /accounts/{accountId}/calls/{callId}/recordings/{recordingId}` removes "recording information, media and transcription"; `…/media` and `…/transcription` variants exist. "After the deletion is requested and a `204` is returned, neither the recording metadata nor the actual media nor its transcription will be accessible anymore. However, the media … is not deleted immediately. This deletion process, while transparent and irreversible, can take an additional **24 to 48 hours**." ([official Node SDK reference, generated from the API spec](https://cdn.jsdelivr.net/npm/bandwidth-sdk@8.1.2/docs/RecordingsApi.md), read 2026-10-29) **[sdk]** — the developer-portal reference page was not fetchable, and the 24–48 h figure was **not found on any dev.bandwidth.com page** on the second pass. Show it as "up to 48 h (SDK reference)". |
| Confirmable? | Access is blocked immediately after 204, but physical purge is up to 48 h later and there is no purge-complete signal. |
| Transcription | `<Record transcribe>` "Default is false"; may also be requested after the fact with `POST …/recordings/{recordingId}/transcription` ([Record BXML](https://dev.bandwidth.com/docs/voice/bxml/record), [guide](https://dev.bandwidth.com/docs/voice/guides/recording/)). Separate delete (above). |
| Call logs | **Unverified [sdk]:** the SDK reference says "Call information is kept for **7 days** after the calls are hung up"; older single-call lookups return 404 and the list returns `[]` ([CallsApi reference, bandwidth-sdk@8.1.2](https://cdn.jsdelivr.net/npm/bandwidth-sdk@8.1.2/docs/CallsApi.md), read 2026-10-29). A second pass over dev.bandwidth.com (Voice errors page, call-state guides, API reference) and web search found **no corroborating official page**. This is the *API* lookup window of call state; billing / carrier CDR retention is **undocumented**. Report `unknown`. |
| Message bodies | **Contradictory.** Developer docs: "Bandwidth does not store any text message content for privacy reasons - only metadata." ([Messaging](https://dev.bandwidth.com/docs/messaging/), **[doc]**, read 2026-10-29, undated); uploaded media: "Files are stored for up to 48 hours" (same page, applies to files *you upload* — inbound MMS media is not addressed). Support article, `dateModified` 2026-08-18: "Non-HIPAA A2P message content is stored for **72 hours**", retained "strictly for customer support resolution" ([Does Bandwidth store SMS/MMS messages](https://www.bandwidth.com/support/en/articles/12823177-does-bandwidth-store-sms-mms-messages-and-traffic), **[support]**, read 2026-10-29). The two pages cannot both be literally right. **Our code should assume content is held up to 72 h**; the "not stored" claim must not appear in a posture report. Message *metadata* retention: **undocumented** ("queryable", no period). |
| Account-level switches | None found. **Undocumented.** |
| **What we cannot remove** | (1) The **24–48 h** physical purge after a delete. (2) Anything about call records: the 7-day state window is unverified and billing CDRs are undocumented. (3) Message metadata and inbound MMS media retention: undocumented; message content up to 72 h per the support article. (4) A recording that has been stored fewer than 30 days cannot be accelerated except by explicit delete — which is why we must delete rather than rely on the 30-day expiry. |

---

## 4. Self-hosted PBX backends (`sip-bridge/`)

For these, "the provider" is **us**. Deletion is a filesystem operation on a host we operate, so
the question flips: not *can the API delete it* but *what else is writing the same data* and
*does an unlink actually remove it*. Each deployment also still has a **SIP trunk carrier** whose
retention is separate and not covered by any PBX documentation.

### 4.1 Asterisk (ARI)

- **Where recordings land:** stored recordings "are simply files on the file system … in the
  `/recording` subdirectory of the configured `astspooldir` … By default … `/var/spool/asterisk/recording`"
  ([ARI and Media: Recording](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-REST-Interface-ARI/Introduction-to-ARI-and-Media-Manipulation/ARI-and-Media-Part-1-Recording/)).
- **Delete API:** `DELETE /recordings/stored/{recordingName}` ("Delete a stored recording"), since
  Asterisk 12 ([Recordings REST API](https://docs.asterisk.org/Latest_API/API_Documentation/Asterisk_REST_Interface/Recordings_REST_API/)).
  A live recording can be **cancelled** so it is never stored: `DELETE /recordings/live/{name}`
  (same page; and "The `cancel()` method for live recordings causes the live recording to be
  stopped and for it not to be stored on the file system" in the Recording guide above).
- **Retention:** none automatic. Files stay until removed.
- **Channel record semantics:** `POST /channels/{id}/record` "will not capture audio sent to the
  channel. The bridge itself has a record feature" ([Channels REST API](https://docs.asterisk.org/Latest_API/API_Documentation/Asterisk_REST_Interface/Channels_REST_API/)).
- **Other writers (not exhaustively audited):** Asterisk's CDR/CEL backends and log files carry
  caller ids on the PBX host. The Asterisk CDR documentation page was not fetchable on 2026-10-29
  (the fetch returned an empty shell), so their default state is **undocumented here** — verify
  against the deployed `cdr.conf`, `cel.conf` and `logger.conf`.
- **Transcription:** none built in.
- **What we cannot remove:** the carrier's CDRs (undocumented, carrier-specific); Asterisk's own
  CDR/CEL/log files until we configure and purge them; filesystem remanence and snapshots of the
  disk (an unlink is not an erase, and we have not tested `shred`-class behaviour on the deploy
  filesystem).

### 4.2 FreeSWITCH (ESL)

- **Recording:** ESL `uuid_record <uuid> start <path>`; the bridge writes to `/tmp/recordings/`
  (`sip-bridge/src/clients/esl-client.ts`). FreeSWITCH publishes a `RECORD_STOP` event with
  `Record-File-Path`. No FreeSWITCH-side retention exists; the file is ours.
- **CDR:** "FreeSWITCH generates one Call Detail Record (CDR) per call leg at hangup. … `mod_cdr_csv`
  … is loaded by default in the vanilla configuration", writing `caller_id_number`,
  `destination_number`, timestamps and `uuid` to `Master.csv`, rotated only when asked
  ([Chapter 27: Call Detail Records](https://developer.signalwire.com/freeswitch/integration/cdr.md)).
  There is no automatic expiry.
- **Delete:** no FreeSWITCH API; deletion is `unlink` on the host (what `EslClient.deleteRecording`
  does).
- **What we cannot remove:** the carrier's CDRs; `Master.csv` and rotated CDR files unless the module
  is unloaded or its logs purged; remanence/snapshots.

### 4.3 Kamailio

- A SIP proxy: **no media, so no recordings or transcripts.** `KamailioClient` throws on every
  recording method (`sip-bridge/src/clients/kamailio-client.ts`).
- The `acc` module records call accounting to syslog (`log_flag`) and/or a database (`db_flag`,
  `db_url`) ([Kamailio acc module](https://www.kamailio.org/docs/modules/stable/modules/acc.html)).
  Whether a given deployment enables either is a config fact; the module has **no retention
  setting of its own** that we found on that page.
- **What we cannot remove:** whatever `acc`/syslog/the trunk carrier wrote.

---

## 5. Where our implementation diverges from what the providers document

Read against `apps/worker/telephony/` and `sip-bridge/` at `origin/main` aaec93495. #2304 reported
the first three; they are **still present on this base** (their fixes had not landed when this was
written — re-check before relying on this list).

### 5.1 Structural: no deletion path exists at all

| Finding | Evidence |
|---|---|
| `TelephonyAdapter` has no `deleteRecording`, `deleteCall`, `deleteTranscript`, `redactMessage` or equivalent. All eight adapters can only *fetch* recordings (`getCallRecording`, `getRecordingAudio`). | `apps/worker/telephony/adapter.ts` — no delete method on the interface. |
| `BridgeClient.deleteRecording` exists for ARI / ESL / Kamailio but has **no callers**, and the bridge HTTP surface exposes only `GET /recordings/…` (no `DELETE`). | `sip-bridge/src/bridge-client.ts:223`, `sip-bridge/src/index.ts:235`. |
| Both real implementations **swallow every error** (`catch { /* already deleted */ }`), so a failed delete is indistinguishable from success. | `ari-client.ts:623`, `esl-client.ts:593`. |
| The ESL client writes recordings under world-writable `/tmp/recordings/`. | `esl-client.ts:553`. |

### 5.2 Confirmability

| Provider | Can we confirm a delete happened? |
|---|---|
| Twilio | Yes — `status=deleted`, media 404; metadata visible 40 days |
| Plivo | Partly — repeat delete returns the documented 404; recoverability undocumented |
| Telnyx | Yes — "can no longer be downloaded"; delete returns the resource |
| Bandwidth | Partly — inaccessible at 204, physical purge 24–48 h later, no signal |
| Vonage | No documented status; Media API returns only "Successfully deleted"; id mapping undocumented |
| SignalWire | No — response is empty body; reversibility undocumented |
| Asterisk / FreeSWITCH | We can `stat` the file ourselves, but not whether blocks were overwritten |

### 5.3 Per-adapter deltas against the provider's own docs

| Adapter | Our code | What the provider documents | Consequence |
|---|---|---|---|
| **Plivo** | `parseRecordingWebhook` stores `RecordingID` as `recordingSid`; `getRecordingAudio` then `safeFetch`es that value **as a URL** (`plivo.ts:441-446`, `:369`). | `RecordingID` is an id; the URL is `RecordUrl` / `recording_url`, or `media.plivo.com/v1/Account/{auth_id}/Recording/{recording_id}.mp3` ([Recordings API](https://www.plivo.com/docs/voice/api/recording/list-all-recordings)). | Fetch can never succeed with an id. Also, the id is exactly what a delete call needs, so the webhook parser is *right* for deletion and wrong for fetching. |
| **Bandwidth** | `getRecordingAudio` calls `/recordings/{id}/media` under `…/accounts/{accountId}` (`bandwidth.ts:340`). | Media path is `/accounts/{accountId}/calls/{callId}/recordings/{recordingId}/media` — **`callId` is required** ([SDK reference](https://cdn.jsdelivr.net/npm/bandwidth-sdk@8.1.2/docs/RecordingsApi.md)). | Fetch 404s. The adapter interface passes only a recording id, so the call id has to be threaded through to fix this **and** to delete (delete has the same path shape). |
| **Vonage** | Authenticates recording downloads with `Basic apiKey:apiSecret` (`vonage.ts:400,410`); `getCallRecording` reads `recording_url` off `GET /v1/calls/{uuid}`. | Download needs "a JWT signed by the same application key that created the recording" ([guide](https://developer.vonage.com/en/voice/voice-api/guides/recording)). `recording_url` on the call resource is **undocumented** in the pages read; the documented source is the `eventUrl` webhook. | Fetch likely fails; and `getRecordingAudio` sends API credentials to whatever URL the webhook carried (the exfiltration risk #2304 and the 2026-06-25 backend audit H6 describe). |
| **Telnyx** | `getRecordingAudio(url)` GETs the webhook's URL with `Authorization: Bearer <apiKey>` **later** (`telnyx.ts:132`, `:523`); `getCallRecording` is hard-wired to `null` (`:519`). | The webhook URL is pre-signed and "active for 10 minutes"; `GET /v2/recordings/{id}` returns fresh `download_urls` ([guide](https://developers.telnyx.com/docs/voice/programmable-voice/storing-call-recordings), [retrieve](https://developers.telnyx.com/api-reference/call-recordings/retrieve-a-call-recording)). | A fetch after 10 minutes fails; a bearer key is sent to an S3 host. The id (not the URL) is what delete needs; the code keeps only the URL in `recordingSid`. |
| **Twilio / SignalWire** | Fetch `…/Recordings/{sid}.wav` with Basic auth; SignalWire swaps only the base URL. | Twilio: matches the documented media URL pattern. SignalWire: media fetch pattern **not verified** against SignalWire's pages (its Compatibility reference documents list/delete). | Twilio looks right for fetch. SignalWire's `.wav` fetch and its default-public media URLs need a live-account check. |
| **Voicemail transcription** | `transcribeVoicemail` calls `getCallRecording(callSid)`; for Telnyx that is always `null`. | — | Voicemail transcription silently no-ops on Telnyx. |
| **FreeSWITCH** | Never records the bridged call (`void params.recordCall`, `freeswitch.ts:206`) — only voicemail. | Documented capability exists (`uuid_record`). | Not a privacy defect; a feature gap that the "emulate" list below addresses. |
| **Hub opt-in** | All cloud adapters emit no record directive unless `params.recordCall` (#1505). | Consistent with Twilio's "absent `record` attribute means Twilio never writes the audio" comment in `twilio.ts:203`. | Good: the primary mitigation is **not creating** the provider copy. Keep it. |

---

## 6. Cross-provider synthesis — what is safe to depend on

### 6.1 Capability matrix (documented only)

`✔` = documented API call. `—` = not documented / not found (see [gaps](#gaps-and-searches-run)). `~` = documented with a caveat.

| Capability | Twilio | SignalWire | Vonage | Plivo | Telnyx | Bandwidth | Asterisk | FreeSWITCH |
|---|---|---|---|---|---|---|---|---|
| Delete a recording by id | ✔ | ✔ | ✔ (Media API) ~ id mapping | ✔ | ✔ (+bulk) | ✔ | ✔ (host) | ✔ (host unlink) |
| Delete confirmable (status/404) | ✔ | — | — | ~ (404 on repeat) | ✔ | ~ (24–48 h) | host-only | host-only |
| Delete is irreversible & immediate | ✔ media; metadata 40 d | — | — | ✔ "permanently" | ✔ | ~ purge up to 48 h (SDK ref.) | host-only | host-only |
| Automatic recording expiry | PCI Mode only | — | ✔ 30 d (undated page) | contradictory — assume none | — unverified (1 y, support article only) | ✔ 30 d | — | — |
| Delete a transcript separately | ✔ | ✔ | — | ✔ | ✔ | ✔ | n/a | n/a |
| Transcription off unless requested | ✔ | — | ✔ | ✔ | ✔ | ✔ | n/a | n/a |
| Delete a call record | ✔ (not its recordings) | ✔ | ~ legs only | — | — | — | host-only | host-only |
| Redact call numbers in the log | — | — | ✔ (Redact API) | ~ at 90 d, last 3 digits | — | — | host-only | host-only |
| Delete/redact a message body | ✔ | ~ (logs read-only) | ✔ (Redact) | ✔ (`log=false`) | ~ read-time, allow-listed | — | n/a | n/a |
| Customer-key encryption of provider-held recording | ✔ (RSA) | — | — | — | ✔ (store to *our* bucket) | — | n/a | n/a |
| Recording lands in *our* storage | ~ (external storage exists, not assessed) | — | — | — | ✔ (S3/GCS/Azure) | — | ✔ | ✔ |

### 6.2 Safe to depend on across **every** provider

These hold for all eight in the documented sense, so shared code may assume them:

1. **Do not create the provider copy.** Every cloud adapter can be told not to record
   (`params.recordCall`, #1505) and none transcribes unless asked. This is the only control that is
   uniformly available **and** uniformly verifiable (no object exists to delete). It is the
   foundation; deletion is the fallback.
2. **Delete a recording by an id the provider hands us in the recording webhook** — available on all
   six cloud providers (Twilio ✔, SignalWire ✔, Vonage ✔*, Plivo ✔, Telnyx ✔, Bandwidth ✔), on the
   PBXs by host filesystem. (*Vonage id mapping is undocumented.)
   → The adapter contract must carry the **provider's delete key**, not only a fetch handle: Twilio
   `RecordingSid`; Plivo `RecordingID`; Telnyx `recording_id`; Bandwidth `callId` **and** `recordingId`;
   SignalWire `RecordingSid`; Vonage media id.
3. **Delete a transcript separately from its recording** — documented for Twilio, SignalWire, Plivo,
   Telnyx, Bandwidth. **Vonage is the exception**. Since we do not use provider transcription
   (client-side Whisper), the safe move is to never enable it.

### 6.3 Must be emulated on our side (some provider lacks it)

| Gap | Providers affected | What our stack must do |
|---|---|---|
| **No confirmable delete** | SignalWire, Vonage (and Bandwidth for 24–48 h) | Treat delete as *requested*, not *done*. Record a signed deletion receipt (request time, provider response, id) in the audit log; do not tell an operator "removed" — say "deletion requested; provider does not confirm". Where possible, re-fetch after a delay and log the result. |
| **No automatic expiry, or a contradictory one** | Twilio (no PCI), SignalWire, Plivo, Asterisk, FreeSWITCH | Own the TTL: delete in-band as soon as the recording is ingested and encrypted into our store (do not wait for expiry), plus a sweeper job that deletes any provider recording older than N hours and flags any it cannot delete. |
| **Log/CDR retention we cannot shorten** | All six clouds | Cannot be emulated. Minimise what goes *into* provider logs (see §7.4): no PII in query strings, TwiML/NCCO text, or webhook echoes; never answer provider webhooks with caller data in the body. State the residue honestly in the posture report. |
| **No call-record delete** | Plivo, Telnyx, Bandwidth | Residue; do not offer "delete call log" in any admin UI for these. |
| **No number redaction in the log** | all but Vonage | Residue (Plivo masks last 3 digits after 90 days). |
| **Message bodies with no delete** | Telnyx (read-time only), Bandwidth (no API), SignalWire (logs read-only) | Do not rely on provider message storage; use the existing server-side-encrypt-then-discard path ([Key patterns: E2EE messaging](../../CLAUDE.md)) and per-message no-store flags where they exist (Twilio `ContentRetention=discard`, Plivo `log=false`). |
| **Default-public media URLs** | SignalWire | Turn on Media URL Protection for every project we use; verify at provider onboarding. |
| **Provider-side plaintext during a call** | all six clouds | Not removable. The only mitigation is not recording and keeping caller data out of the path (§7). SFrame voice E2EE exists for the **volunteer leg** via our bridge, not for the PSTN leg. |
| **Fetch URL/auth shape differs** | Vonage (JWT), Telnyx (10-min pre-signed), Bandwidth (call id in path), Plivo (id vs URL) | Normalise behind one adapter method that takes a provider-shaped opaque handle (`RecordingRef`), so the worker never builds a URL from a webhook value. Fixes the §5.3 defects structurally. |

---

## 7. Ideas — making our encrypted recording, transcription, log retention and IVR work better across providers

Operator ask C8, second half. These are proposals, not commitments; each names the evidence it
leans on. Ordered by leverage.

### 7.1 Recording

1. **Ingest-encrypt-delete as a single provider-agnostic step.** On the recording webhook:
   fetch once (normalised `RecordingRef`), envelope-encrypt immediately (HPKE per reader, same as
   notes), then call the provider's delete. Only delete once the ciphertext is durably stored; log
   the delete result. This is the one design that works with every provider's delete API (§6.2) and
   shrinks the provider-held window from "indefinite" to "seconds".
2. **Prefer provider-side customer-key encryption where it exists, as defence in depth, not the
   plan.** Twilio's Voice Recording Encryption (RSA public key, `rsa-aes`) means a leaked Twilio
   object is ciphertext to Twilio and to anyone who breaches it later. Telnyx can write to a bucket
   *we* own (S3/GCS/Azure), so the provider never holds the object after delivery. Neither covers
   in-call plaintext, and the other four providers offer nothing comparable — so it cannot be the
   shared mechanism.
3. **Capability flags on the adapter, derived from this document.** Expose
   `retention: { autoExpiryDays | null, deleteConfirmable, deleteLatencyHours, metadataResidueDays }`
   per provider and have the admin UI/posture report read it, instead of prose in a doc that drifts.
   Hand-write it once from §3 and add a test that fails when a provider adds an adapter without it.
4. **Hub posture says what is true per provider.** For SignalWire and Vonage the report must say
   "deletion requested, not confirmed"; for Twilio "metadata retained 40 days"; for Bandwidth
   "purge completes within 48 h". Never one global "deleted".
5. **Default to not recording** (already #1505) and surface the recording-notice IVR prompt as part
   of the same setting so the disclosure and the capture can't disagree (already done).

### 7.2 Transcription

1. **Keep it client-side** (Whisper in the webview, audio never leaves the browser per
   `CLAUDE.md`). It is the only transcription path with identical behaviour on all providers and
   no third-party copy of the text. Do **not** enable any provider transcription feature: Twilio's
   is deprecated and unavailable under PCI Mode; Vonage's has no documented separate delete.
2. **Voicemail is the exception that needs thought.** The server-side voicemail path pulls audio
   from the provider and transcribes with `env.AI` (`apps/worker/services/transcription.ts`),
   i.e. plaintext audio transits our server and a third-party model. For a "zero-knowledge" posture,
   either transcribe voicemail on an admin's device (fetch ciphertext, decrypt, transcribe) or
   document that voicemail audio is server-visible. (Out of scope here; flagged for the posture
   report.)
3. **Telnyx voicemail transcription is currently a no-op** (`getCallRecording` returns `null`);
   fix with the `RecordingRef` change rather than by enabling provider transcription.

### 7.3 Log retention

1. **Our own log is the one we control: apply the same minimisation here.** Keep the hash-chained
   audit log and the call table to what the admin needs, and give `calls` a retention sweep so we
   are never the long pole after a provider purges (Plivo 90 d, Bandwidth 7 d, Vonage 13 mo).
2. **Stop feeding provider logs.** Concrete leaks to audit: query strings in `action`/callback URLs
   (`?parentCallSid=…&hub=…` — non-PII today, keep it that way); webhook error bodies (Twilio
   Monitor Alerts store `response_body` and `request_variables`, undeletable); the IVR speech URL
   (`SpeechUrlBuilder` already warns the text is readable from the URL in a log and restricts it to
   text any caller hears, and keeps CAPTCHA digits out — preserve both).
3. **Vonage-specific:** if Vonage is ever recommended, onboarding must include requesting Redact
   API access and enabling Standard Auto-Redact, and the posture report must state that voice server
   logs (15–30 days) are out of reach.
4. **Twilio-specific:** set message-log retention to the 7-day minimum in the Messaging Console;
   record in the posture report that Voice Insights keeps 30 days regardless.

### 7.4 IVR

1. **Serve prompts as audio we host, not provider TTS text.** Every cloud adapter already supports
   `Play`-by-URL (`audioUrls`) and the worker has its own speech engine for the PBXs
   (`SpeechUrlBuilder`). Using it for *all* providers keeps IVR text out of provider logs, makes
   voices identical across providers, and removes the per-provider voice-catalog constraints that
   `ivr-menu.ts` exists to manage. Trade-off: the provider fetches our URL (so our request log sees
   prompt fetches) and a cache/CDN question for latency; the URL must stay free of caller data.
2. **DTMF is logged by the provider whatever we do** (digits arrive in webhooks and, on Twilio,
   may be echoed in Monitor Alerts on error). Keep the IVR to non-sensitive digits (language,
   CAPTCHA) and never collect anything identifying by keypad.
3. **Language menu determinism** (`ivr-menu.ts`) is already provider-independent — keep it as the
   model for how to hide provider variation behind one constructed artefact.

### 7.5 Provider-selection input (the recommendation this audit was commissioned to feed)

Not a recommendation — what the evidence supports so far, for whoever writes it:

- **Least residue, most confirmable deletes:** Twilio (documented, confirmable delete; PCI Mode as
  an auto-expiry; customer-key encryption; message redaction) — at the cost of undeletable Voice
  Insights (30 d) and Monitor Alerts, and 40-day metadata.
- **Strongest log redaction:** Vonage (Redact API overwrites numbers permanently), but voice server
  logs (15–30 d) are unreachable and delete confirmation is weak.
- **Shortest hard lifetime:** Bandwidth (30-day recording expiry, 7-day call state), with a
  24–48 h purge lag.
- **Weakest documentation:** SignalWire and Telnyx for logs; Plivo for recordings. Their gaps are
  gaps in *what we can promise*, not evidence of safety.
- **Self-hosted PBX** removes the provider copy but moves the burden to us and to the trunk
  carrier, whose retention no PBX documentation covers.

---

## 8. Implications for #2309

1. A provider-delete worker needs, per provider, the **delete key** and a documented endpoint —
   §6.2 lists them. `TelephonyAdapter` has no such method today (§5.1), so #2309 is an *interface
   addition*, not a wiring job.
2. Where §5.3 shows the stored handle is the wrong shape (Plivo id-vs-URL, Telnyx URL-only,
   Bandwidth missing `callId`, Vonage media id), fix the handle first or delete will target nothing.
3. Do not log "deleted" from a 2xx alone for SignalWire/Vonage; log "requested".
4. The honest-residue column in §1 is the source for the posture report. Do not summarise it away.
5. The weakly sourced rows were re-checked on 2026-10-29 and are now labelled at the point of use.
   Outcome: Plivo 90-day CDR/MDR and Bandwidth 30-day recording are **confirmed on official docs**;
   Telnyx 1-year / 10-day, Bandwidth 7-day / 24–48 h / 72-hour and Plivo 7-year / message-`log`
   defaults remain **unverified**; Bandwidth message content and Plivo recording retention are
   **contradictory** on the provider's own pages. See "Safe to build on" at the top: build on the
   `doc` column, report `unknown` for the rest, and assume the longer period wherever sources disagree.

---

## Gaps and searches run

Each line is something I looked for and did **not** find. None of these means "absent".

| Gap | Searched |
|---|---|
| Twilio default recording retention (no PCI) | Recording, Call and Voice Settings docs; web "Twilio recording retention default". The only support article found returned HTTP 403. |
| Twilio Voice Insights / Alerts delete | Voice Insights search; Monitor Alerts page (no `DELETE` on it). |
| SignalWire recording / call / message retention | Compatibility API pages; Record-calls guide; docs `llms.txt`; web ×3. |
| SignalWire reversibility of delete | Delete-recording page. |
| Vonage voice recording delete id mapping (`/v1/files` ↔ `/v3/media`) | Voice API, Media API, Redact pages; web ×3. |
| Vonage transcript delete | Voice and Media pages. |
| Plivo recording retention (conflict) | Recordings API, Record XML, Download-recordings pages, support FAQ. |
| Plivo warehouse copies ("up to 7 years") in current docs | Plivo docs, support, privacy policy (generic 7-year account-data statement only), web ×2. Only the 2018 blog describes a redacted warehouse. |
| Plivo recording retention tiebreak | Record XML (30 d), Recordings API / Download recordings (90 d free), support storage-charge article (not re-read, JS-rendered). No page is dated. |
| Telnyx recording retention in developer docs | Storing-call-recordings and Retrieve-recording pages (none); web ×2 (only the support article). |
| Telnyx CDR / MDR retention; message delete | Developer docs, support, data-privacy page, release notes; `DELETE /v2/messages` search. |
| Bandwidth 7-day call state and 24–48 h purge on dev.bandwidth.com | Voice errors, call-state guide (404), API reference, Recording guide; web ×2. Only the SDK reference states them. |
| Bandwidth message-content contradiction | Messaging docs ("does not store") vs. support article (72 h). Not resolved by any third page. |
| Twilio message-log 7–400 day configurability on a docs page | Messaging redaction guide, 2020 changelog (400 days, not configurable per page), web. Help-centre articles are JS-rendered and unreadable. |
| Bandwidth CDR beyond 7 days; message metadata and MMS media retention; account switches | dev.bandwidth.com pages, SDK docs, support site. |
| Asterisk CDR / CEL / log defaults | Asterisk CDR documentation page returned an empty shell; not read. |
| Kamailio `acc` retention | `acc` module page: no retention parameter. |
| Twilio / Telnyx **external storage** assessment | Telnyx documented; Twilio external storage exists (Recording resource says media "uploaded to external storage" is not fetchable) but was not assessed here. |

## Sources (all fetched 2026-10-29)

Twilio: [Recording](https://www.twilio.com/docs/voice/api/recording) ·
[Call](https://www.twilio.com/docs/voice/api/call-resource) ·
[Message](https://www.twilio.com/docs/messaging/api/message-resource) ·
[Recording Transcription](https://www.twilio.com/docs/voice/api/recording-transcription) ·
[Voice Recording Encryption](https://www.twilio.com/docs/voice/tutorials/voice-recording-encryption) ·
[Monitor Alerts](https://www.twilio.com/docs/usage/monitor-alert) ·
[error 17002](https://www.twilio.com/docs/api/errors/17002) ·
[PCI changelog 2020](https://www.twilio.com/en-us/changelog/payment-card-industry--pci--compliant-voice-recordings) ·
[PCI changelog 2025](https://www.twilio.com/en-us/changelog/updates-to-voice-pci-recordings-console-setting-and-retention-policy) ·
[Messaging data controls](https://twilio.com/blog/new-data-controls-twilio-messaging).
SignalWire: [Delete Recording](https://signalwire.com/docs/compatibility-api/rest/recordings/delete-recording) ·
[Delete Call](https://signalwire.com/docs/compatibility-api/rest/calls/delete-a-call) ·
[Delete Message](https://signalwire.com/docs/compatibility-api/rest/messages/delete-message) ·
[Delete Transcription](https://signalwire.com/docs/compatibility-api/rest/recording-transcriptions/delete-transcription) ·
[Record calls](https://signalwire.com/docs/swml/guides/record-calls).
Vonage: [Call Recording](https://developer.vonage.com/en/voice/voice-api/guides/recording) ·
[Redact your data](https://developer.vonage.com/en/redact/technical-details) ·
[Redact API](https://developer.vonage.com/en/api/redact) ·
[Media API](https://developer.vonage.com/en/api/media).
Plivo: [Recordings API](https://www.plivo.com/docs/voice/api/recording/list-all-recordings) ·
[Delete a Recording](https://www.plivo.com/docs/voice/api/recording/delete-a-recording) ·
[Record element](https://www.plivo.com/docs/voice/xml/record) ·
[Download recordings](https://www.plivo.com/docs/voice/use-cases/download-recordings) ·
[GDPR CDR/MDR](https://plivo.com/blog/plivo-gdpr-update-cdr-and-mdr-compliance-done) ·
[Message storage options](https://plivo.com/blog/advanced-message-storage-options).
Telnyx: [Delete recording](https://developers.telnyx.com/api-reference/call-recordings/delete-a-call-recording) ·
[Bulk delete](https://developers.telnyx.com/api-reference/call-recordings/delete-a-list-of-call-recordings) ·
[Retrieve recording](https://developers.telnyx.com/api-reference/call-recordings/retrieve-a-call-recording) ·
[Storing recordings](https://developers.telnyx.com/docs/voice/programmable-voice/storing-call-recordings) ·
[record_start](https://developers.telnyx.com/api-reference/call-commands/recording-start) ·
[Message redaction](https://developers.telnyx.com/docs/messaging/messages/message-redaction) ·
[Call recording (support)](https://support.telnyx.com/en/articles/5377454-call-recording) ·
[SMS MDR (support)](https://support.telnyx.com/en/articles/1130611-understand-telnyx-sms-mdr).
Second-pass sources (all read 2026-10-29): [Plivo Messaging › Reporting](https://www.plivo.com/docs/messaging/concepts/reporting) · [Plivo SIP-trunking › List all calls](https://plivo.com/docs/sip-trunking/api/call/get-cdr-of-call) · [Plivo Send a message](https://www.plivo.com/docs/messaging/api/message/send-a-message) · [Plivo Privacy Policy, updated 2026-05-27](https://www.plivo.com/legal/privacy/) · [Telnyx Retrieve a message](https://developers.telnyx.com/api-reference/messages/retrieve-a-message) · [Telnyx Message Detail Records](https://developers.telnyx.com/docs/messaging/messages/message-detail-records) · [Bandwidth Messaging](https://dev.bandwidth.com/docs/messaging/) · [Twilio Message redaction](https://www.twilio.com/docs/messaging/guides/privacy-message-redaction) · [Twilio messaging data availability changelog, 2020-10-14](https://www.twilio.com/en-us/changelog/messaging-data-availability-updated-to-13-months).
Bandwidth: [Record BXML](https://dev.bandwidth.com/docs/voice/bxml/record) ·
[Record and transcribe guide](https://dev.bandwidth.com/docs/voice/guides/recording/) ·
[RecordingsApi SDK reference](https://cdn.jsdelivr.net/npm/bandwidth-sdk@8.1.2/docs/RecordingsApi.md) ·
[CallsApi SDK reference](https://cdn.jsdelivr.net/npm/bandwidth-sdk@8.1.2/docs/CallsApi.md) ·
[Message storage (support)](https://www.bandwidth.com/support/en/articles/12823177-does-bandwidth-store-sms-mms-messages-and-traffic).
Asterisk: [Recordings REST API](https://docs.asterisk.org/Latest_API/API_Documentation/Asterisk_REST_Interface/Recordings_REST_API/) ·
[Channels REST API](https://docs.asterisk.org/Latest_API/API_Documentation/Asterisk_REST_Interface/Channels_REST_API/) ·
[ARI and Media: Recording](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-REST-Interface-ARI/Introduction-to-ARI-and-Media-Manipulation/ARI-and-Media-Part-1-Recording/).
FreeSWITCH: [Call Detail Records](https://developer.signalwire.com/freeswitch/integration/cdr.md).
Kamailio: [acc module](https://www.kamailio.org/docs/modules/stable/modules/acc.html).
