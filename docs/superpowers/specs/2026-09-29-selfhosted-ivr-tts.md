# Self-hosted generated IVR speech (#1347) — technical spec

**Status:** authoritative research spec for #1347. Implementation is PR #1351 (`fix-tts`),
stacked on #1349 → #1335. §9 records where #1351 already matches this spec and where it
does not.

**Scope.** On Asterisk and FreeSWITCH, how a prompt that no operator has uploaded gets
spoken. This covers:
- what the PBX requires;
- which engine is used and how its output is verified;
- how clips are keyed and invalidated;
- why an upload wins;
- how the system makes sure a caller never gets unexplained silence.

It does **not** cover hold music (a music asset, #1316) or the hub scoping of `ivr_audio`.

## Evidence legend

Every factual claim carries one of these tags.

| Tag | Meaning |
|---|---|
| **[M]** | **Measured.** I ran it. The number is mine. |
| **[S]** | **Source-read.** Read in primary source at a pinned version, but not executed. |
| **[R]** | **Reasoned** from [M] or [S]. |
| **[P]** | **Reported by the implementing peer** (`fix-tts`, #1351). I have not verified it. |
| **[U]** | **Unverified**, or could not determine. See §10. |

Measurement host: a shared AMD Ryzen 7 5700G (16 threads), under a load average of about 17 from
other workers. Treat all latencies as upper-bound-ish.

---

## 1. Recommendation

1. **Synthesise in the worker, not at the PBX.** Confirmed. The bridge-side design failed for three
   reasons, and all three were measured on the pinned PBX (§3, §4):
   - a `file://` media URI gets no PlaybackFinished at all;
   - the file lived in a container Asterisk can't read;
   - espeak writes 22.05 kHz audio, which `.wav` rejects.

   Worker-side synthesis served over `sound:http://…` avoids all three.
2. **Do not store generated clips in `ivr_audio`.** This refutes the storage half of the proposal on
   the table. Instead, serve them from a **signed, content-addressed, non-expiring URL** whose path
   names the engine, the locale and the exact text. Reasons (§7.1):
   - `ivr_audio` is instance-wide and keyed by `(promptType, language)`. The greeting (`{name}`) and
     the menu line (`[N]` digit) are per-hub text. Storing them there needs a schema change, a
     reconcile job and a GC job; a content-addressed URL needs none of the three.
   - The part of the path #1335 verified with a carrier recording is PBX-side: `res_http_media_cache`
     plus `format_wav`. A content-addressed route reuses exactly that part.
   - The content address is also what makes the PBX cache correct (§3.3). A stable per-prompt URL
     is either stale (with `max-age`) or re-fetched on every call (without it).
3. **Engine: espeak-ng as the default, Piper as an opt-in per locale.**
   - Default: **espeak-ng 1.52** (Debian trixie package, GPL-3.0-or-later, which is compatible with
     our AGPL-3.0). It has voices for 19 of 22 locales [M], adds about 28 MB installed [M], and takes
     8–23 ms per prompt [M].
   - **Piper** is a per-locale, opt-in quality upgrade. Each opt-in is gated on a **licence decision
     per voice** (§6.3): for most of our locales, every Piper voice is non-commercial or is derived
     from research-only data.
   - **Meta MMS-TTS** is not recommended: CC-BY-NC-4.0, no numerals, 1.5 GB RSS. It is nonetheless
     the only engine found for `tl` and `so`.
4. **Locale policy, driven by measured intelligibility over a simulated phone line** (§6.2):
   - generate normally: en es ko pt fr vi tr de ru;
   - generate, with an operator warning that quality is degraded: zh fa uk ht hi;
   - generate, with an operator warning that it is unverified: am ku quc;
   - **fall back and warn: ar** (espeak-ng Arabic is unintelligible: CER 0.75, or 0.49 even with
     diacritisation, against a human floor of 0.04) **and my** (espeak-ng Burmese IPA is garbled);
   - no engine at all, so fall back and warn: tl→en, so→en, mix→es.
5. **First-call cost: lazy synthesis with prefetch at URL-mint time, plus an eager self-test at
   startup.** espeak-ng is cheap enough that the first caller in a locale waits tens of ms [M], or
   150–270 ms in the app image [P]. If Piper is adopted, switch that locale to eager generation into
   a persistent content-addressed store (§7.6).
6. **Silence without the operator being told must be impossible.** §8 specifies the static guards,
   the precedence chain, the runtime reporting of failed playbacks (ARI already reports them, §3.4)
   and the coverage matrix the operator sees.

## 2. Corrections to the premises

| Premise | Finding | Tag |
|---|---|---|
| "8 prompt keys × 23 locales, up to 184 recordings" | There are **22** locales (22 files in `packages/i18n/locales`, 22 `LANGUAGES` entries), so at most **176** | [M] |
| The pinned Asterisk is "20.x" (`deploy/ansible/vars.example.yml`) | The same digest (`sha256:e30df5ec…`) runs **Asterisk 22.8.2** on Debian 13. The compose files correctly say 22.x | [M] |
| My own first message to fix-tts, from reading the source: a data-size-0 WAV "plays 0 ms and reports success" | Wrong. It **fails** to play (`PLAYBACKSTATUS=FAILED`, ARI `state:"failed"`), and it is not a silent success. I corrected this with fix-tts. #1335's validator already rejects it | [M] |
| #1335's validator matches what Asterisk plays | **One false accept:** a valid RIFF WAV with an odd-sized chunk before `data`. The validator skips the pad byte; `format_wav` does not, so it fails with `Read failed (block header format)`. Fixed in #1351 [P] | [M] |
| FreeSWITCH's `<speak>` fallback works for English at least | mod_httapi **rejects `<speak>` without an `engine` attribute** ("speak: missing engine attribute!"), and our adapter emits `<speak voice="slt">` with none. flite is English-only in any case | [S] |
| On the base, the Asterisk adapter's `speak` fallback has text | `connecting`, `holdMusic`, `captcha`, `captchaFailed` and `voicemailThankYou` have **no text** in `voice-prompts.ts`, so `getPrompt` returned `''` (#1346). Fixed in #1351 by mapping each to an existing key [S] | [S] |
| The Asterisk language menu is the uploaded-audio path | At b7bfba4bc every menu option was a `speak`, which the bridge skips. **The entry point was silent even with uploads** | [S] |

---

## 3. Asterisk media playback (22.8.2)

Method: the pinned image, `--network none`, with a Python HTTP server inside the container.
Prompts were driven both through dialplan `Playback()` and through ARI `POST /channels/{id}/play`
with an event listener. §11.1 has the details. For a 2.0 s clip a success reads about 2.50 s,
because answering the channel plus timing costs about 0.5 s; a failure reads about 0.50 s.

### 3.1 Media URI schemes
- **Schemes [S]:** `sound:`, `recording:`, `number:`, `digits:`, `characters:`, `tone:`
  (`res/res_stasis_playback.c`). HTTP media is **`sound:http(s)://…`**, handed to `ast_streamfile`,
  which routes any path containing `://` to the media cache (`main/file.c`).
- **Unsupported schemes [M].** `POST /play` accepts **any** string with `201`. With `file:///…`, or a
  bare `http://…` without `sound:`, **no PlaybackFinished event ever arrives** (none within 8 s). The
  playback loop `continue`s past the unknown scheme without publishing a final state [S]. This is how
  `tts-engine.ts` "played" silence, and it would leave a bridge waiting forever to hang up.
- **`tone:` is unsuitable as a fallback prompt [S].** `ast_control_tone` plays until a stop control
  frame or a hangup, so it never finishes on its own.

### 3.2 What `res_http_media_cache` requires

The documented and undocumented requirements, all [M] unless tagged otherwise.

| Requirement | Behaviour when unmet |
|---|---|
| `/var/cache/asterisk` exists and the `asterisk` user can write to it | `Failed to create temporary storage`, FAILED, and **zero** HTTP requests are made (reproduces #1335) |
| A 2xx response | FAILED. A 404 or 503 logs `Failed to retrieve URL … server returned N` |
| The file type is derivable: Content-Type first, then the URL path's extension (`bucket_file_set_extension`) | `audio/wav`, `audio/x-wav` and `audio/wav; charset=binary` play. **`audio/wave`, `application/octet-stream`, no Content-Type, and a 200 `text/html` all FAIL** on an extensionless URL ("does not exist in any format"). `application/octet-stream` on a URL ending in `.wav` plays |
| The bytes match the derived format module exactly | A 16 kHz body served as `audio/wav` FAILS. The same bytes served as `audio/x-wav;codec=pcm;bit=16;rate=16000` play as `wav16` |
| Latency | The fetch is **synchronous in the channel**. A 2 s server delay added **about 2.1 s of dead air** before the prompt. A loopback fetch of a 32 KB clip added 0–80 ms |
| Timeout | `timeout_secs` defaults to **180 s** [S]. `deploy/docker/asterisk-config/` has no `res_http_media_cache.conf`, so a hung app means up to 3 minutes of silence per prompt [R] |
| Failed-type fetches | Still leave an extensionless file in `/var/cache/asterisk` (4 of 18 files in the run) |
| Request-line length | The ARI request line must be ≤ **4096 bytes** (`MAX_HTTP_LINE_LENGTH`, `main/http.c`) [S]. The longest shipped prompt is 333 UTF-8 bytes (`my` `waitMessage`) [M], so a base64 text-in-URL fits comfortably |

### 3.3 Caching semantics [M]

| Response headers | Play 1 | Play 2 | After content changes behind the same URL |
|---|---|---|---|
| none (the route at b7bfba4bc) | GET | **GET** (full re-fetch every play) | always fresh |
| `Cache-Control: max-age=3600` | GET | cache hit | **stale: the old clip played** (2.0 s instead of the new 1.0 s) |
| `ETag`, no Cache-Control | GET | HEAD `If-None-Match` → 304, cache hit | HEAD → 200, then GET, new clip |
| `ETag` + `no-cache` | GET | HEAD revalidate | same as above |
| re-fetch gets a 503 | GET, OK | **FAILED.** The stale entry is deleted *before* the re-fetch, with no fallback to it | — |
| `?v=1`, `?v=2`, `?v=3` | 3 GETs, **3 cache files, 3 astdb `MediaCache` rows** | never evicted | — |

Consequences [R]:
- The cache is keyed by the **full URL** and is **never evicted**, except when the same URL is
  re-hit while stale, or on startup when a row's file is missing [S].
- Its index lives in **astdb** (`database show MediaCache` [M]), and compose persists astdb as a
  volume. So every *distinct* URL costs one file plus one row until the container is re-created.

The only URL shape that is both correct and bounded is a **content address**: the URL changes if
and only if the bytes change, and it is served `immutable`.

### 3.4 Failure reporting [M]
- **ARI reports the failure:** `PlaybackFinished` with `playback.state: "failed"`, within about 0.1 s,
  for a 404, a format mismatch or an undetermined type.
- **Before #1351 it was invisible:** at b7bfba4bc, `sip-bridge` mapped `PlaybackFinished` and dropped
  `state`, so a failed prompt looked identical to one that played [S]. #1351 plumbs `state` through
  and logs failures, excluding ones interrupted by hangup [P].
- This event is the runtime signal §8 builds on.

---

## 4. Audio format: `format_wav` truth table [M]

The same crafted files went through Asterisk 22.8.2 (local `Playback`) and through #1335's
`ivrAudioFormatError` (run with bun on the b7bfba4bc source).

| Variant | Asterisk `.wav` | #1335 validator |
|---|---|---|
| 8 kHz, mono, 16-bit PCM, 44-byte header | ✅ plays 2.0 s | accept |
| `fmt ` chunk of size 18 (cbSize = 0) | ✅ | accept |
| Even-sized `LIST` chunk before `data` | ✅ | accept |
| 4000-byte `LIST` chunk before `data` | ✅ but **252 ms cut from the end** | accept |
| **Odd-sized chunk + pad byte before `data`** (valid RIFF) | ❌ `Read failed (block header format)` | **accept (false accept)** |
| 16 kHz as `.wav` | ❌ `Unexpected frequency mismatch 16000 (expecting 8000)` | reject |
| 16 kHz as `.wav16` | ✅ | reject (the validator allows 8 kHz only) |
| 22.05 kHz (what espeak-ng and Piper emit) | ❌ frequency mismatch | reject |
| Stereo | ❌ `Not in mono 2` | reject |
| 8-bit | ❌ `Can only handle 16bits per sample: 1` | reject |
| WAVE_FORMAT_EXTENSIBLE (0xFFFE) | ❌ `Not a supported wav file format (65534)` | reject |
| Float32 / µ-law WAV | ❌ format 3 / 7 | reject |
| Data size 0 | ❌ FAILED | reject |
| Data size 0xFFFFFFFF (streaming header) | ❌ `Unable to open format wav` | reject |
| Header claims 2 s, file holds 1 s | ✅ plays 1.0 s | reject |
| `bitsPerSample` = 24 but block-align 2 | ✅ (the bits field is never checked) | reject |

Notes on the table:
- **Why the tail is cut [S].** `wav_open` stores the data chunk's *length* as `maxlen`, but `wav_read`
  compares it against the *absolute* file offset. So every file loses its header size from the tail:
  2.75 ms for a canonical 44-byte header, 252 ms with a 4 KB `LIST`.

**Conclusion [M].**
- "8 kHz mono 16-bit PCM WAV" is exactly `.wav`'s requirement. It is not folklore.
- 16 kHz plays only through `.wav16` or the parametrised MIME type, and is pointless over G.711
  anyway [R].
- **Generated audio must be written as a canonical 44-byte header over raw PCM.** Never pass an
  engine's own WAV container through: the extensible, streaming and odd-chunk rows above all fail.
- Generated clips must also pass `ivrAudioFormatError`, the same gate as uploads, as a test-time
  guard.

---

## 5. FreeSWITCH equivalent [S]

Everything in this section is read from FreeSWITCH `master` source. The repo deploys no FreeSWITCH
(there is no compose or Ansible role for it), so **nothing here was measured** [U].

- **HTTP prompts.**
  - Our adapter uses mod_httapi XML. `<playback file="http://…"/>` is fetched by mod_httapi's own
    file cache.
  - The extension comes from the URL, or from Content-Type via `mime.types`: `audio/wav`,
    `audio/wave`, `audio/x-wav` and `audio/x-wave` all map to `wav`.
  - mod_sndfile plays it, and the core resamples whenever the file rate differs from the channel
    rate (`switch_core_file.c`). So the canonical 8 kHz clip that Asterisk needs also works here.
- **Cache defaults** (`mod_httapi.c`):
  - `file-cache-ttl` is **300 s**;
  - **`file-not-found-expires` is 300 s**, so one 404 silences that prompt for 5 minutes. The speech
    route must therefore never answer 404 to a validly signed URL (§8.3);
  - `mod_http_cache`'s `default-max-age` is 86 400 s when the origin sends none. This one comes
    from the FreeSWITCH docs, not the source.

  A content-addressed URL makes all three harmless [R].
- **`<speak>`** requires an `engine` attribute, and our adapter emits none, so every `<speak>` fails.
  This is moot once every prompt is a `<playback>` of generated speech, which #1351 does [P].
- **ESL `playMedia`** sends `uuid_broadcast <uuid> sound:http://…`. `sound:` is ARI syntax that
  FreeSWITCH does not know. This only matters if the ESL path is ever used for prompts; today the
  httapi XML path is used.

---

## 6. Engine selection

### 6.1 Candidates [M unless tagged]

| | espeak-ng 1.52 | Piper (piper1-gpl 1.8.0) | Meta MMS-TTS |
|---|---|---|---|
| **Licence (code)** | GPL-3.0-or-later | GPL-3.0-or-later. The MIT `rhasspy/piper` C++ repo is **archived**; its last release was 2023-11-14 [M: GitHub API] | Model: CC-BY-NC-4.0 |
| **Licence (voices)** | Rule-based, with no training data | **Per voice**, and mostly problematic (§6.3) | NC |
| **Runtime size** | ~28 MB installed (`espeak-ng` + `-data` + libs, Debian trixie) | 46 MB package (bundles espeak-ng-data and a 4.7 MB Arabic diacritiser) + 62 MB onnxruntime + Python. The archived C++ binary is 26.5 MB (x86_64) / 26.0 MB (aarch64) | torch + transformers (hundreds of MB) |
| **Per-voice model** | none | 63 MB (medium), 77 MB (mls / ukrainian_tts / ku), 20–28 MB (x_low) | 145 MB per language (`model.safetensors`) |
| **Memory** | negligible | **143–307 MB peak RSS per voice process** | 1.5 GB peak RSS (8 models, one process) |
| **Latency** | **8–23 ms per prompt** (CLI, including spawn). #1351 reports 150–270 ms per prompt in the app image, including TS resampling [P] | Load 1.0–4.5 s per voice, then RTF 0.05–0.21 (multi-threaded; 0.1–2.5 s per prompt) | RTF ≥ 1 on CPU with torch |
| **Output rate** | 22 050 Hz, all 19 voices | 22 050 Hz (medium) or 16 000 Hz (x_low) | 16 000 Hz |
| **8 kHz direct?** | No, resample | No, resample. A 16 kHz voice makes it a clean 2:1 decimation | No, resample |
| **Digits ("4 7 2 9")** | Spoken in-language | Spoken in-language (ar, hi, ru heard as correct digits) | **Fails** for 6 of 8 languages: no numerals in vocab, runtime error on an empty token sequence |
| **Voices for our locales** | **19/22** (all except tl, so, mix) | **15/22** claimed by `voices.json` (none for tl, ht, so, am, my, quc, mix). All 20 voices tested synthesise | Probed the HF repos: `tgl`, `som`, `hat`, `amh`, `mya`, `kor`, `tur` and `kmr-script_latin` exist; **`quc`, `mix` and `cmn` do not**. 13 other Mixtec varieties do exist |

Unmeasured candidates [U]:
- **Kokoro-82M** (Apache-2.0; en, es, fr, hi, it, pt-BR, ja, zh);
- **sherpa-onnx** as a maintained Apache-2.0 runtime for Piper, MMS or Kokoro ONNX models;
- **Chatterbox-multilingual** (MIT, 23 languages, but GPU-class compute);
- **XTTS**, **F5** and **Fish**, all excluded for non-commercial weights.

### 6.2 Per-locale intelligibility over a simulated phone line [M]

**The instrument.** Each clip went through:
1. the phone channel: resample to 8 kHz, then µ-law 8-bit, then back to 16 kHz;
2. Whisper **large-v3** (int8, language forced, greedy);
3. CER of `pleaseHold` plus the menu line ("…press 3", scoring either the numeral or the local
   word) against the i18n source.

**The instrument was calibrated first.** Real human speech (FLEURS test, 3 utterances per language)
went through the same channel and the same judge. That gives the "judge floor" column. Where the
floor is about 1.0, **the judge cannot hear that language at all, and a bad engine score there means
nothing.**

**Why calibration is not optional.** An uncalibrated Whisper-*small* run on the same espeak-ng
output (#1351 [P]) suggested narrowband badly hurts ko, ru and de. The calibrated large-v3 judge
scores those at CER 0.00 / 0.14 / 0.13.

| Locale | Judge floor (human) | espeak-ng | Piper (voice: CER) | MMS | Recommended default |
|---|---|---|---|---|---|
| en | 0.018 | **0.00** | norman: 0.00 | – | espeak-ng |
| es | 0.003 | **0.00** | carlfm (x_low): 0.00, ald: 0.08 | – | espeak-ng |
| ko | – | **0.00** | kss: 0.00 | 0.03 | espeak-ng |
| pt | – | **0.00** | faber: 0.00 | – | espeak-ng |
| fr | – | 0.09 | siwis: 0.00, *mls: 0.36* | – | espeak-ng |
| vi | – | 0.11 | vais1000: 0.03 | – | espeak-ng |
| tr | – | 0.11 | dfki: 0.00 | 0.05 | espeak-ng |
| de | – | 0.13 | thorsten: 0.00, *mls: 0.57* | – | espeak-ng |
| ru | – | 0.14 | denis: 0.00 | – | espeak-ng |
| zh | – | 0.20 | huayan: 0.10 | – | espeak-ng + **degraded warning** |
| fa | 0.058 | 0.20 | amir: 0.25 | – | espeak-ng + **degraded warning** |
| uk | 0.011 | 0.23 (menu line garbled) | **lada (x_low): 0.00**, ukrainian_tts: 0.07 | – | espeak-ng + warning. **lada is the one licence-clean neural upgrade with a measured gain** |
| ht | – (not in FLEURS) | 0.28 | none | 0.33 | espeak-ng + **degraded warning** |
| hi | 0.082 | 0.29 | priyamvada: 0.06 | – | espeak-ng + **degraded warning** |
| **ar** | 0.038 | **0.75** (0.49 with MIT libtashkeel diacritisation) | kareem: **0.00** with piper's built-in tashkeel, **0.22 without** | – | **fall back and warn** until a neural voice is licensed or the prompt is uploaded |
| am | **0.991 (judge invalid)** | not measurable. IPA looks plausible (`sost` = ሦስት) | none | not measurable | espeak-ng + **unverified warning** |
| my | **1.000 (judge invalid)** | not measurable. **IPA is garbled** (`mrn mtsbtsðts…` for မြန်မာ) | none | not measurable | **fall back and warn** |
| ku | no Whisper model | not measurable. IPA plausible (`ʒɪ bˈo kʊrdˈi … sˈe`) | berfin (synthesises; NC) | kmr (not run) | espeak-ng + **unverified warning** |
| quc | no Whisper model | not measurable. **Words with `ch'` are spelled out as English letters** (`(en)siːeɪtʃ`) | none | none | espeak-ng + **unverified warning** |
| tl | 0.151 | no voice | none | 0.12 | **fall back → en** |
| so | 0.326 | no voice | none | 0.29 | **fall back → en** |
| mix | no Whisper model | no voice | none | none (not `mix`) | **fall back → es** |

Reading notes:
- **Tiers.** "Degraded" means espeak CER between 0.2 and 0.3: partly intelligible, and robotic.
  "Unverified" means no valid instrument exists, so we cannot claim the output is intelligible.
- **Arabic diacritisation.** Piper's Arabic result depends on piper1-gpl running **libtashkeel
  diacritisation automatically** (`use_tashkeel=True`, espeak voice `ar`). Any other runtime must be
  re-measured for Arabic [U].
- **Naturalness is not measured.** ASR measures intelligibility only. Whether an espeak-ng voice
  sounds too cold for a crisis line is unmeasured [U]. That is an argument for nudging operators to
  record the menu and hold prompts in their primary languages (§8.4).

### 6.3 Piper voice licences for our locales [M: MODEL_CARD per voice]

- **Non-commercial** (CC BY-NC or BY-NC-SA). These cover *every* Piper voice for **ko** (kss),
  **tr** (dfki) and **ku** (berfin_renas):
  - ko_KR kss;
  - tr_TR dfki;
  - ku_TR berfin_renas;
  - hi_IN pratham / priyamvada;
  - zh_CN xiao_ya;
  - ru_RU ruslan;
  - en_US ryan;
  - de_DE pavoque;
  - vi_VN vivos.
- **"Finetuned from en_US-lessac".** The Lessac Blizzard-2013 data licence is *research only*, and
  forbids "the development … of voice synthesis … products" and derived products [M: licence page].
  Voices in this group:
  - ar kareem (its dataset repo has **no licence at all**);
  - de thorsten (medium/high);
  - es davefx / sharvard / daniela, and es ald (fine-tuned from davefx);
  - fa amir / reza_ibrahim, and fa ganji / ganji_adabi (via amir);
  - fr siwis-medium / upmc;
  - hi rohan;
  - pt cadu / faber / jeff / tugão;
  - ru denis / dmitri / irina;
  - vi vais1000;
  - zh huayan;
  - many en voices.

  Whether a fine-tune on a CC0 dataset launders the base model is a **legal question, not a
  technical one** [U].
- **"Finetuned from U.S. English Ryan (low)".** en_US-ryan is itself CC BY-NC-SA. Voices in this
  group:
  - de karlsson / kerstin / thorsten-low;
  - en kathleen-low;
  - es mls_9972 / mls_10246;
  - fr gilles / mls_1840 / siwis-low;
  - pt edresson;
  - vi 25hours_single.
- **From scratch, permissive:**
  - en norman / kristin (public domain);
  - es carlfm x_low (public domain);
  - uk lada x_low (Apache-2.0) and ukrainian_tts (CC0);
  - de and fr `mls` (CC-BY-4.0), which **measured poor** (0.57 / 0.36).

**So:** a default neural voice set that is licence-clean covers only en, es and uk, and only uk
shows a measured intelligibility gain over espeak-ng. Everything else needs a recorded,
per-voice licence decision by the maintainers before it is bundled or offered.

### 6.4 Engine recommendation
- **Default: espeak-ng from the distro package, in the app image.** One engine, 19 voices, licence-clean,
  and negligible cost. The §6.2 table decides each locale's tier.
- **Opt-in neural voices** come from a reviewed manifest. Each entry carries: locale, voice id,
  **model sha256**, licence, provenance, and the measured CER from this method. It is enabled per
  locale only after the licence decision.
  - Priority by measured gain: **ar** (0.75 → 0.00), **hi** (0.29 → 0.06), **uk** (0.23 → 0.00;
    clean), zh (0.20 → 0.10), ru, de, vi, tr.
  - The runtime must diacritise Arabic.
  - Adopting Piper changes the first-call model (§7.6).
- **MMS** could fill `tl` and `so` only under an NC licence decision, and would need an ONNX
  runtime and a numeral-to-words step [U].

---

## 7. Architecture

### 7.1 Where synthesis happens, and where clips live
- **Synthesis happens in the worker** [R from §3, §4]. The worker has the text, locale, hub name
  and menu order, and it is the origin the PBX already fetches from.
- **Clips are not stored in `ivr_audio`.** A generated clip's identity is its URL: the path names
  the engine tag, the locale and the exact text, and an HMAC restricts it to text the worker chose.
  The worker serves it from a bounded in-memory cache and re-synthesises on a miss. This is what
  #1351 implements [P, and S on its source]. Why this and not storage:
  1. **Per-hub text.** The greeting (`{name}`) and the menu line (`[N]`) are per-hub.
     `ivr_audio`'s key `(promptType, language)` is instance-wide. Storing per-hub clips there would
     need a hub column, a reconcile job and a GC. Keying by text makes all three unnecessary, and
     cross-hub leakage of a hotline name impossible by construction [R].
  2. **Invalidation is exact and free:** a new text or a new engine tag is a new URL (§7.3).
  3. **Caching is correct on both PBXs:** immutable and bounded (§3.3, §5).
  4. **Replica- and restart-safe:** no server state, so any replica can serve any URL.
- **If a slow engine is adopted** (Piper: seconds to load, 150–300 MB per voice), add a persistent
  content-addressed clip store keyed by the **same** clip key and filled eagerly (§7.6). The route
  checks it before synthesising. The URL contract does not change [R].

### 7.2 One mechanism, not three
- **One playback verb.** On Asterisk and FreeSWITCH, every prompt becomes `play <url>`. **`speak`
  leaves the self-hosted vocabulary entirely**: the bridge only ever logged it and skipped it.
- **One resolver.** A single resolver in `SipBridgeAdapter` (#1351's `promptUrl`) chooses the URL
  for both PBXs. Adapters never choose.
- **One serving module.** Uploaded and generated media are served by one route module, with one set
  of response rules: `audio/wav`, signed, and 404 on any refusal except §8.3.
- **One format writer and one gate.** Generated bytes come from one canonical-WAV writer, and a
  test runs `ivrAudioFormatError` over them, so an engine upgrade can't change the container
  unnoticed.
- **Result:** downstream of the resolver (bridge, ARI, `res_http_media_cache`, mod_httapi), an
  uploaded and a generated prompt are the same thing, a URL that returns 8 kHz PCM WAV. The cloud
  providers keep their own `<Say>`. That is the provider's engine, not a third path of ours.

### 7.3 Keying and invalidation

The clip key is:

```
sha256( engineTag ‖ locale ‖ exactText )
engineTag = hash( engine version string, voice table, AUDIO_PIPELINE_REVISION )   // #1351
```

| Change | Effect |
|---|---|
| An i18n string edited and deployed | The next call's text differs, so a new URL is minted. The old URL is simply never minted again |
| Hub name or IVR language order changed | Same: greeting and menu texts change |
| espeak-ng upgraded, voice table edited, resampler or header code changed | A new engine tag, so every URL changes. `AUDIO_PIPELINE_REVISION` **must** be bumped by any change to the post-processing |
| Upload added or deleted | No clip changes. The resolver's first step changes its answer (§7.4) |

- **Stale entries [R].** Old clips linger in Asterisk's cache, one file per distinct text ever
  played. That set is bounded by the product of prompts, locales and configuration changes.
- **Exception: per-call text.** #1351 speaks the CAPTCHA as one text per call (`"4 7 2 9"`). That
  creates a new URL per challenge: up to 10⁴ cache entries per locale, each persisted in astdb **with
  the answer base64-encoded in its key**. **Speak the digits as ten stable per-locale clips (`"0"` …
  `"9"`) played in sequence instead.** Both engines speak single digits in-language [M].

### 7.4 Precedence: the operator's upload always wins
- **The resolution order.** Evaluated in exactly one function:
  1. `upload(key, lang)`;
  2. `generated(key, lang)`, only if `lang`'s tier is not "fall back";
  3. `upload(key, fallback(lang))`;
  4. `generated(key, fallback(lang))`;
  5. the last-resort clip (§8.3).
- **Why it cannot invert** [R]:
  - generated audio is never written to `ivr_audio`, so no write path can shadow or overwrite an
    upload;
  - the only reader that chooses between the two is the resolver;
  - a unit test asserts the full matrix: {Asterisk, FreeSWITCH} × every requested key × every
    locale, with an upload present, must yield the upload URL. With the upload deleted, the same
    cell must yield a generated or fallback URL, never nothing.
- **Gap in #1351 (step 3).** It goes from step 1 to step 4 directly. For a tl, so, mix or ar caller,
  it plays *generated* English or Spanish even when the operator *uploaded* that prompt in the
  fallback language. Reported to fix-tts.

### 7.5 URL contract
- **Generated speech.** Content-addressed path ending in `.wav`, HMAC-signed with **no expiry**
  (the content is public text), served with `audio/wav`, `Cache-Control: public, max-age=31536000,
  immutable` and `ETag: "<clip key>"`. #1351 does this [S].
- **Uploads.** #1349 signs upload URLs with an expiry bucketed to **300 s**, a legitimate revocation
  window, since an upload can carry a staff member's voice.
  - **The cost, from §3.3 [R]:** one new cache file plus one persistent astdb row per uploaded
    prompt per active 5-minute window, never evicted until the container is re-created. The worst
    case is about 90 MB a day: 5 uploaded prompts × 288 windows × a ~64 KB clip (4 s at 8 kHz,
    16-bit), on a line with a call in every window.
  - **Choose deliberately:** a longer bucket (a day gives at most one entry per prompt per day), or
    periodic eviction. Reported to fix-tts.
- **Line length.** Keep `MAX_TEXT_BYTES` low enough that the whole ARI request line stays under
  4096 bytes. #1351's 2048 does [S].

### 7.6 Cost of the first call: lazy with prefetch, and eager self-test

**espeak-ng is lazy.** It synthesises on a cache miss, and the synthesis is *started when the URL
is minted* (in the webhook), so it overlaps the bridge and ARI round trip. #1351 does this [P].
- First-caller dead air is roughly synthesis time minus the mint-to-fetch gap: tens of ms [M], or
  150–270 ms in the app image [P].
- Eager generation would take about 176 × 15 ms ≈ 3 s, but it needs triggers, storage and GC for no
  audible gain [R].
- **Every restart** empties the in-memory cache, and the next caller in each locale pays this again.

**Eager self-test at startup (required).** Synthesise one probe per voiced locale.
- If the engine is missing or broken, flag it *before* a caller does (§8.4).
- It must not gate `/health/ready`: calls must still work on uploads when the engine is down [R].

**Piper would be eager.** One job per locale: load the voice (1–4.5 s), render every required clip,
unload. Results go to the persistent content-addressed store.
- If Piper were lazy, the first caller would get seconds of dead air [M: load + RTF].
- A resident voice per locale would hold 150–300 MB each, which is several GB for the full set [M].

**FreeSWITCH** caches a 404 for 300 s (§5), which is another reason a valid signed URL must always
yield audio.

---

## 8. Silence must be impossible without the operator having been told

**The invariant:** a caller may hear a fallback, but never unexplained silence. Every fallback
leaves a trace that an operator sees without having to go looking.

### 8.1 Static guards (CI)
1. **Every key has text.** Every prompt key the self-hosted adapters request resolves to
   **non-empty** text in **every** shipped locale. This closes #1346's `speak ''` class. #1351 has
   `ivr-prompt-keys.test.ts` [P].
2. **Every locale has a voice or a fallback.** Every shipped locale is either voiced, with a tier,
   or has an explicit fallback, and a test enumerates `LANGUAGE_CODES`. #1351 has the
   voiced-or-fallback check [P]. **Tiers are missing** (§9).
3. **Generated bytes pass the gate.** `ivrAudioFormatError` passes on every voice's output, and the
   header is canonical.
4. **The voice manifest cites evidence.** It records each tier with its §6.2 evidence. A tier other
   than "accepted" must map to an operator-visible warning. It is never silently "voiced".

### 8.2 Resolution chain
The chain is §7.4.
- **Fallback languages** are explicit per locale, never "closest": tl→en, so→en, mix→es, and
  ar→es|en and my→en (pending the maintainers' choice).
- **Language menu.** A language with neither a voice nor an upload is omitted from the menu. Its
  digit stays reserved, per `ivr-menu.ts` rule 2. Phone-prefix detection (`+63`, `+252`) still
  routes such callers to the right hub language, and they hear the fallback-language prompts.

### 8.3 Runtime
- **The route always returns audio.** A validly signed speech URL always yields audio, never a 404
  or 5xx. If synthesis fails, the route serves a **worker-generated last-resort clip** and records
  the failure:
  - a finite sine-beep sequence, rendered in-process with no engine, and format-valid;
  - it keeps the caller oriented, lets PlaybackFinished fire so the call flow continues, and
    sidesteps FreeSWITCH's 404 cache.

  `tone:` is **not** usable for this (§3.1).
- **The bridge reports failed prompts.** It sends `PlaybackFinished{state:"failed"}` to the app as an
  event carrying the media URL. Hangup-interrupted playbacks are excluded [P]. The app attributes
  each failure to (hub, prompt, locale) and keeps timestamped counts.
- **Tune the fetch timeout.** Set `res_http_media_cache.conf` `timeout_secs` to a few seconds
  (currently unset, so 180 s), so a hung origin fails fast into a reportable state [R].

### 8.4 What the operator sees
**Status is derived at read time.** It comes from the uploads, the voice manifest, the startup
self-test and the failure counts. It is never cached.

1. **The prompt matrix** in the admin voice-prompts page. Rows are the prompts, including the menu
   line and the CAPTCHA digits; columns are the hub's enabled languages. Each cell is one of:
   - **Uploaded**;
   - **Generated**, with the engine and voice;
   - **Generated: degraded / unverified**, with a link to the evidence;
   - **Falls back to ‹lang›**, with the reason;
   - **Not announced in the menu**;
   - **Engine down**.
2. **A persistent dashboard warning** while any of these holds:
   - an enabled language is not Uploaded or Generated-accepted;
   - the self-test failed;
   - any prompt failed to play in the last 24 h.

   The warning names the languages and says what callers hear instead.
3. **Upload nudges.** For degraded or unverified cells: "callers hear a synthetic voice that may be
   hard to understand; record this prompt". Upload is always the remedy. Language selection is the
   entry point, so the menu line is listed first.

---

## 9. Alignment with PR #1351 (reviewed at `b0b695261`)

Rows marked **[P]** rely on fix-tts's report or its commits; the rest I read in #1351's source.

| This spec | #1351 |
|---|---|
| Worker synthesis, espeak-ng, 19 voices, fallbacks tl/so/mix | ✅ |
| Content-addressed, signed, non-expiring, `immutable` speech URLs | ✅ |
| Canonical 44-byte WAV; validator rejects odd chunks | ✅ [P] |
| Prompt keys all have text (#1346) | ✅ keys remapped, with a test [P] |
| Menu options are generated speech in their own language | ✅. `ASTERISK_VOICES` is now derived from the voice table |
| Prefetch at URL mint | ✅ [P] |
| ARI failed state plumbed through the bridge | ✅ logged [P]. Reporting to the app and the UI (§8.3–8.4) is **not** in the file list |
| **ar** and **my** treated as fall back and warn | ❌ both are "voiced" |
| am, ku and quc labelled unverified | ❌ `voices.ts` says each voice was checked against the locale's script |
| Precedence step 3 (upload in the fallback language) | ❌ |
| CAPTCHA as ten per-digit clips | ❌ one text per call |
| Upload URL expiry vs cache growth trade-off | ⚠️ 300 s buckets. Growth is undocumented |
| Last-resort clip instead of 5xx; startup self-test; `timeout_secs` | ❌ not present |
| Coverage matrix and dashboard warning | ❌ no UI files in the PR |

---

## 10. What I could not determine

1. **Human-perceived quality.** ASR measures intelligibility, not warmth or trust, and no listening
   test was run.
2. **Intelligibility for am and my.** The Whisper large-v3 judge fails on human speech in both
   (CER 0.99 and 1.00). Only IPA inspection was possible: am plausible, my garbled.
3. **Intelligibility for ku, quc and mix.** No ASR model exists; IPA inspection only.
4. **A human floor for ht.** Haitian Creole is not in FLEURS, so its 0.28–0.33 cannot be compared
   against one.
5. **Licensing.** This is legal: whether lessac-derived and CC-BY-NC Piper voices may be bundled or
   offered by an AGPL, non-profit, self-hosted deployment. Also whether MMS's NC licence permits the
   same.
6. **FreeSWITCH.** Source-read only. No instance was measured, and the repo deploys none.
7. **A real carrier.** My channel is continuous µ-law companding plus 8-bit quantisation, which is
   not bit-exact G.711 and has no packet loss. #1351 reports real carrier recordings for en and fr
   [P].
8. **The pilot's hardware.** My latencies come from a loaded 16-thread desktop. Piper's RTF on a
   2-vCPU VPS is unknown; espeak-ng's is irrelevant at this scale.
9. **Other runtimes.** Whether the archived C++ Piper, or sherpa-onnx, diacritises Arabic as
   piper1-gpl does. Arabic quality depends on it (0.00 vs 0.22).
10. **Mixtec variety.** Which one our `mix` translation is written in. `mix` is ISO 639-3 Mixtepec,
    and the label "Tu'un savi" is generic.
11. **HEAD requests.** Whether Hono answers HEAD revalidation on the upload route (only relevant if
    ETag revalidation is adopted there).
12. **Kokoro, sherpa-onnx and Chatterbox** were not measured.

---

## 11. Method (for reproduction)

### 11.1 Asterisk lab

The container:
- runs `andrius/asterisk@sha256:e30df5ec…` (22.8.2) with `--network none` as root, starting Asterisk
  with `-U asterisk -G asterisk`;
- uses a minimal `/etc/asterisk`: modules `autoload=yes`, `http.conf` on 127.0.0.1:18088, and an ARI
  user;
- serves the crafted WAVs from a Python `ThreadingHTTPServer` on 127.0.0.1:18080, with per-path
  Content-Type, Cache-Control and ETag, and a request log.

Each dialplan case is originated with `channel originate Local/<case>@play application Wait 40` and
runs:

```
exten => <case>,1,Set(T0=${FILTER(0-9,${SHELL(date +%s%3N)})})
 same => n,Playback(<file-or-url>)
 same => n,Set(T1=${FILTER(0-9,${SHELL(date +%s%3N)})})
 same => n,Log(NOTICE,RESULT <case> ${PLAYBACKSTATUS} $[${T1}-${T0}])
```

The ARI cases:
1. originate `Local/park@wait` into Stasis app `lab`;
2. wait for `StasisStart`;
3. `POST /channels/{id}/play?media=…&playbackId=…`;
4. read `PlaybackFinished.playback.state` from a raw websocket reader.

The cache cases compare play counts against the server's request log. The final state is taken from
`media cache show all` and `database show MediaCache`.

### 11.2 Synthesis
- **espeak-ng:** `espeak-ng -v <voice> -w out.wav <text>` on `debian:trixie` (1.52.0+dfsg-5), plus
  `--ipa` output.
- **Piper:** `piper-tts==1.8.0` `PiperVoice.load()` then `synthesize()`, one process per voice, with
  a warm-up call before timing.
- **MMS:** `transformers` `VitsModel` with uroman where `tokenizer.is_uroman`.
- **Corpus:** `voice.pleaseHold`, `ivr.selfAnnouncement` with `[N]`=3, `voice.voicemailPrompt`, and
  `"4 7 2 9"`, taken from `packages/i18n/locales/*.json` for each locale.

### 11.3 Judge
- `faster-whisper 1.2.1`, `large-v3`, `int8`, CPU, `language=<locale>`, `beam_size=1`,
  `temperature=0`, no VAD.
- **Channel:** `resample_poly` to 8 kHz, then µ-law (µ=255, 8-bit), then 16 kHz.
- **Scoring:** one window per (engine, voice, locale) containing `pleaseHold` + menu line.
- **Normalisation:** NFKC, lowercase, punctuation stripped, Arabic and Persian letter-form folding,
  opencc t2s for zh, no spaces for zh/ko/my/am.
- **Calibration:** the first 3 FLEURS `test` utterances per language, streamed from the dataset's
  tarballs.

**Instrument errors found and corrected during this work:**
- digits spoken as *words* were being scored as text errors, which made Piper ar and hi look bad;
- the calibration windows had been truncated at 30 s against full references.

Both were re-run; only the corrected numbers appear above.
