//! Cross-platform byte equality for the envelope AAD.
//!
//! The AAD rule is spelled out in exactly two places — `packages/shared/envelope-aad.ts`
//! for every TypeScript surface, and `packages/crypto/src/envelope_aad.rs` for
//! Rust and, through UniFFI, for Kotlin and Swift. Two languages cannot share
//! one source file, so nothing but a test keeps the two from drifting: a
//! divergence here is silent at compile time and shows up only as "this client
//! cannot read anything that client wrote", which is how #1517 and #1520 came
//! to exist in the first place.
//!
//! The third leg, Kotlin, is deliberately *not* a third derivation. The
//! generated binding forwards `mobileContentAadHex` / `mobileKeyWrapAadHex`
//! straight into the Rust above, so Kotlin's bytes are Rust's bytes by
//! construction — provided the binding is actually regenerated and the call
//! sites actually use it. Both of those are checked below, because a stale
//! tracked binding is indistinguishable from a correct one until it is loaded.

use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    // tests/ → packages/crypto → packages → <root>
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crate is not two levels below the repo root")
        .to_path_buf()
}

fn read(rel: &str) -> String {
    let path = repo_root().join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {} — {e}", path.display()))
}

/// Extract the string literal assigned to a `const NAME = '...'` in TypeScript.
fn ts_const(source: &str, name: &str) -> String {
    let needle = format!("export const {name} = ");
    let rest = source
        .split_once(&needle)
        .unwrap_or_else(|| panic!("{name} is not exported from envelope-aad.ts"))
        .1;
    let quote = rest.chars().next().expect("empty const");
    assert!(
        quote == '\'' || quote == '"',
        "{name} is not a string literal"
    );
    rest[1..]
        .split(quote)
        .next()
        .expect("unterminated string literal")
        .to_string()
}

/// The TypeScript definition and the Rust definition must agree, byte for
/// byte, for every label in the registry — not just for the handful a unit
/// test would think to name.
#[test]
fn rust_and_typescript_derive_identical_aad_for_every_label() {
    let ts = read("packages/shared/envelope-aad.ts");

    // The TS rule, read out of the TS source rather than restated here.
    let suffix = ts_const(&ts, "KEY_WRAP_AAD_SUFFIX");
    assert_eq!(
        suffix,
        llamenos_core::KEY_WRAP_AAD_SUFFIX,
        "the key-wrap suffix has diverged between TypeScript and Rust"
    );
    assert!(
        ts.contains("return utf8ToBytes(label)"),
        "contentAad in envelope-aad.ts no longer returns UTF-8(label); \
         the Rust side still does and the two have diverged"
    );
    assert!(
        ts.contains("return utf8ToBytes(`${label}${KEY_WRAP_AAD_SUFFIX}`)"),
        "keyWrapAad in envelope-aad.ts no longer appends KEY_WRAP_AAD_SUFFIX; \
         the Rust side still does and the two have diverged"
    );

    let mut checked = 0usize;
    for label in llamenos_core::labels::LABEL_REGISTRY.iter().copied() {
        if label.is_empty() {
            continue; // tombstoned index
        }
        // TypeScript: utf8ToBytes(label) / utf8ToBytes(`${label}${suffix}`)
        assert_eq!(
            llamenos_core::content_aad(label),
            label.as_bytes().to_vec(),
            "content AAD diverges for {label}"
        );
        assert_eq!(
            llamenos_core::key_wrap_aad(label),
            format!("{label}{suffix}").into_bytes(),
            "key-wrap AAD diverges for {label}"
        );
        checked += 1;
    }
    assert!(
        checked > 80,
        "only {checked} labels checked — the registry looks truncated"
    );
}

/// The tracked Kotlin binding must expose the AAD derivation and must carry
/// the `aadHex` parameter on both symmetric entry points.
///
/// `packages/crypto/bindings/kotlin/...` and the copy Gradle compiles under
/// `apps/android/...` are both checked: a regenerated binding that was not
/// copied across is the same stale-artifact failure, one directory later.
#[test]
fn the_generated_kotlin_binding_is_not_stale() {
    for binding in [
        "packages/crypto/bindings/kotlin/org/llamenos/core/llamenos_core.kt",
        "apps/android/app/src/main/java/org/llamenos/core/llamenos_core.kt",
    ] {
        let kt = read(binding);
        for symbol in [
            "fun `mobileContentAadHex`",
            "fun `mobileKeyWrapAadHex`",
            "fun `mobileHexToBase64url`",
            "fun `mobileLabelToId`",
            "fun `mobileBase64urlToHex`",
        ] {
            assert!(
                kt.contains(symbol),
                "{binding} does not export {symbol} — regenerate it with \
                 packages/crypto/scripts/build-mobile.sh android"
            );
        }
        for signature in [
            "fun `mobileSymmetricEncrypt`(`plaintextHex`: kotlin.String, `aadHex`: kotlin.String)",
            "fun `mobileSymmetricDecrypt`(`ciphertextHex`: kotlin.String, `keyHex`: kotlin.String, `aadHex`: kotlin.String)",
        ] {
            assert!(
                kt.contains(signature),
                "{binding} is stale: expected `{signature}`"
            );
        }
    }
}

/// No mobile call site may re-spell the rule.
///
/// The AAD is only single-sourced if nothing writes it out by hand. A Kotlin
/// or Swift literal `:key-wrap` would be an eighth copy — compiling, passing
/// the happy path, and free to drift the moment the suffix changes.
#[test]
fn no_mobile_source_respells_the_key_wrap_suffix() {
    let mut offenders = Vec::new();
    for dir in ["apps/android/app/src/main", "apps/ios/Sources"] {
        let root = repo_root().join(dir);
        let mut stack = vec![root];
        while let Some(path) = stack.pop() {
            let entries = match std::fs::read_dir(&path) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                let is_source = matches!(
                    p.extension().and_then(|e| e.to_str()),
                    Some("kt") | Some("swift")
                );
                // The generated binding is not a hand-written call site.
                let is_generated = p.to_string_lossy().contains("/org/llamenos/core/");
                if !is_source || is_generated {
                    continue;
                }
                if let Ok(body) = std::fs::read_to_string(&p) {
                    // Comment lines may quote the rule while explaining it;
                    // only code may not re-spell it.
                    let in_code = body.lines().any(|line| {
                        let t = line.trim_start();
                        !(t.starts_with("//") || t.starts_with("*") || t.starts_with("/*"))
                            && t.contains(":key-wrap")
                    });
                    if in_code {
                        offenders.push(p.display().to_string());
                    }
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "these mobile sources spell the key-wrap AAD by hand instead of calling \
         mobileKeyWrapAadHex: {offenders:?}"
    );
}

/// The one hand-written copy of the label registry that survives on mobile —
/// Android's `HpkeEnvelope.LABEL_ID_*` constants — must match the registry.
///
/// iOS had the same table and it had drifted: call-metadata and hub-key
/// envelopes were built with `labelId: 0`, which `hpke_open_key` rejects. iOS
/// now derives the id through `mobileLabelToId`; Android still transcribes it,
/// so the transcription is checked.
#[test]
fn androids_label_id_table_matches_the_registry() {
    let kt = read("apps/android/app/src/main/java/org/llamenos/hotline/crypto/CryptoService.kt");
    let expected = [
        ("LABEL_ID_NOTE_KEY", llamenos_core::labels::LABEL_NOTE_KEY),
        ("LABEL_ID_FILE_KEY", llamenos_core::labels::LABEL_FILE_KEY),
        (
            "LABEL_ID_FILE_METADATA",
            llamenos_core::labels::LABEL_FILE_METADATA,
        ),
        (
            "LABEL_ID_HUB_KEY_WRAP",
            llamenos_core::labels::LABEL_HUB_KEY_WRAP,
        ),
        ("LABEL_ID_MESSAGE", llamenos_core::labels::LABEL_MESSAGE),
        ("LABEL_ID_CALL_META", llamenos_core::labels::LABEL_CALL_META),
    ];
    for (constant, label) in expected {
        let id = llamenos_core::labels::label_to_id(label)
            .unwrap_or_else(|| panic!("{label} is not in the registry"));
        let decl = format!("const val {constant} = {id}");
        assert!(
            kt.contains(&decl),
            "CryptoService.kt must declare `{decl}` ({label} is registry index {id})"
        );
    }
}

/// Notes, files, contact identifiers and hub keys are canonical-AAD envelopes
/// on every platform: `content_aad(label)` on the content layer,
/// `key_wrap_aad(label)` on the key wrap. A call site passing an empty AAD
/// beside one of those labels is the #1517-family defect recurring — writer
/// and reader look self-consistent on one platform, and every other platform
/// fails the tag check with no hint of why.
///
/// `LABEL_HUB_KEY_WRAP` was listed as exempt here until #1631, on the grounds
/// that desktop, iOS and Android all passed empty so the three interoperated.
/// They did — with each other, and with nothing else: PROTOCOL.md §2.7, the
/// crate's own `hpke_wrap_key`/`hpke_unwrap_key` pair, and the interop vectors
/// had bound `UTF-8("llamenos:hub-key-wrap:key-wrap")` the whole time. An
/// exemption three clients agree on is still a defect; only the PUK
/// per-device AAD remains a genuinely different convention.
#[test]
fn mobile_never_seals_canonical_envelopes_with_empty_aad() {
    const CANONICAL_LABELS: [&str; 6] = [
        "LABEL_NOTE_KEY",
        "LABEL_FILE_KEY",
        "LABEL_FILE_METADATA",
        "LABEL_CONTACT_ID",
        "LABEL_CONTACT_PROFILE",
        "LABEL_HUB_KEY_WRAP",
    ];
    let mut offenders = Vec::new();
    for dir in ["apps/android/app/src/main", "apps/ios/Sources"] {
        let root = repo_root().join(dir);
        let mut stack = vec![root];
        while let Some(path) = stack.pop() {
            let entries = match std::fs::read_dir(&path) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                let is_source = matches!(
                    p.extension().and_then(|e| e.to_str()),
                    Some("kt") | Some("swift")
                );
                // The generated binding is not a hand-written call site.
                let is_generated = p.to_string_lossy().contains("/org/llamenos/core/");
                if !is_source || is_generated {
                    continue;
                }
                if let Ok(body) = std::fs::read_to_string(&p) {
                    for line in body.lines() {
                        // Comment lines may quote the defect while explaining
                        // it; only code may commit it.
                        let t = line.trim_start();
                        if t.starts_with("//") || t.starts_with("*") || t.starts_with("/*") {
                            continue;
                        }
                        let on_canonical_label = CANONICAL_LABELS.iter().any(|l| line.contains(l));
                        let passes_empty_aad = line.contains("NO_AAD")
                            || line.contains("noAad")
                            || line.contains("aadHex: \"\"");
                        if on_canonical_label && passes_empty_aad {
                            offenders.push(format!("{}: {t}", p.display()));
                        }
                    }
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "these mobile call sites seal a canonical-AAD envelope (note / file / \
         contact) with an empty AAD, which no other platform can open: {offenders:#?}"
    );
}

/// The desktop call sites for the same envelopes are scanned the same way.
///
/// `src/client/lib/platform.ts` seals notes and wraps file/contact keys;
/// `src/client/lib/file-crypto.ts` seals file content and metadata;
/// `src/client/components/signal-notification-section.tsx` seals Signal
/// contact identifiers; `src/client/lib/hub-key-manager.ts` wraps and unwraps
/// the hub key (#1631 — it passed `''` on both). A crypto entry point invoked
/// on the same source line as one of the canonical labels must not pass an
/// empty AAD literal — the pre-fix shape of this line was
/// `hpkeSealKey(keyHex, pub, LABEL_NOTE_KEY, '')`.
///
/// This scan is single-line and so only catches the defect in its original
/// shape; the AAD a call site actually passes is pinned by behaviour, in
/// `src/client/lib/hub-key-manager.test.ts` and `hub_key_wrap_binds_the_composite_aad`.
#[test]
fn desktop_never_seals_canonical_envelopes_with_empty_aad() {
    const CANONICAL_LABELS: [&str; 6] = [
        "LABEL_NOTE_KEY",
        "LABEL_FILE_KEY",
        "LABEL_FILE_METADATA",
        "LABEL_CONTACT_ID",
        "LABEL_CONTACT_PROFILE",
        "LABEL_HUB_KEY_WRAP",
    ];
    const ENCRYPT_FNS: [&str; 6] = [
        "hpkeSealKey",
        "hpkeOpenKeyFromState",
        "aesGcmEncrypt",
        "aesGcmDecrypt",
        "platformWrapHubKeyForMember",
        "hpkeUnwrapAndSetHubKey",
    ];
    let files = [
        "src/client/lib/platform.ts",
        "src/client/lib/file-crypto.ts",
        "src/client/components/signal-notification-section.tsx",
        "src/client/lib/hub-key-manager.ts",
    ];
    let mut offenders = Vec::new();
    for file in files {
        let body = read(file);
        for line in body.lines() {
            let t = line.trim_start();
            // Comment lines may quote the defect while explaining it; only
            // code may commit it.
            if t.starts_with("//") || t.starts_with("*") || t.starts_with("/*") {
                continue;
            }
            let on_canonical_label = CANONICAL_LABELS.iter().any(|l| line.contains(l));
            let is_envelope_call = ENCRYPT_FNS.iter().any(|f| line.contains(f));
            let passes_empty_aad = line.contains("''") || line.contains("\"\"");
            if on_canonical_label && is_envelope_call && passes_empty_aad {
                offenders.push(format!("{file}: {t}"));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "these desktop call sites seal a canonical-AAD envelope (note / file / \
         contact) with an empty AAD, which no other implementation can open: \
         {offenders:#?}"
    );
}

/// The hub-key envelope's AAD, pinned to the spelling `PROTOCOL.md` §2.7 gives
/// and traced to the one call site on each platform that binds it.
///
/// This envelope is the #1631 defect: the desktop, iOS and Android all passed
/// an empty AAD, agreeing with each other and with nothing else — not §2.7,
/// not `hpke_wrap_key`/`hpke_unwrap_key` in this crate, not the interop
/// vectors, and not the BDD seeder, all of which had bound the composite from
/// the start. The operator's adjudication was that the code moves to the spec,
/// so the spelling is pinned as a literal here: a derivation that drifts in
/// casing, in the suffix, or by a trailing byte would otherwise stay
/// self-consistent across all four languages and still be wrong.
///
/// The round trip itself is exercised per platform, not here:
/// `ffi_v3::tests::hub_key_load_binds_the_key_wrap_aad` (Android),
/// `CryptoServiceHubKeyAadTests` (iOS), `hub-key-manager.test.ts` (desktop).
#[test]
fn hub_key_wrap_binds_the_composite_aad() {
    // §2.7: aad = UTF-8("llamenos:hub-key-wrap:key-wrap") on both the seal and
    // the open. Rust is the derivation every platform reaches: directly, via
    // UniFFI (`mobile_key_wrap_aad_hex` — iOS and Android), or via the
    // byte-equal TypeScript mirror pinned by
    // `rust_and_typescript_derive_identical_aad_for_every_label` (desktop).
    assert_eq!(
        llamenos_core::key_wrap_aad(llamenos_core::labels::LABEL_HUB_KEY_WRAP),
        b"llamenos:hub-key-wrap:key-wrap".to_vec(),
        "the hub-key wrap AAD no longer matches PROTOCOL.md §2.7"
    );

    // The desktop call site derives it rather than spelling it, and binds the
    // same value on the wrap and the unwrap. Both passed `''` before #1631.
    let ts = read("src/client/lib/hub-key-manager.ts");
    assert!(
        ts.contains("keyWrapAadHex(LABEL_HUB_KEY_WRAP)"),
        "hub-key-manager.ts no longer derives its AAD from @shared/envelope-aad"
    );
    for call in ["platformWrapHubKeyForMember", "hpkeUnwrapAndSetHubKey"] {
        // The invocation, not the import of the same name: match on the
        // opening paren.
        let invocation = format!("{call}(");
        let after = ts
            .split_once(&invocation)
            .unwrap_or_else(|| panic!("hub-key-manager.ts no longer calls {call}"))
            .1;
        // The argument list, whether it is written on one line or several.
        let args = after.split(')').next().unwrap_or_default();
        assert!(
            args.contains("HUB_KEY_WRAP_AAD_HEX"),
            "hub-key-manager.ts calls {call} without the composite AAD: {args:?}"
        );
    }

    // iOS reaches the same derivation through UniFFI, and no longer has the
    // `noAad` constant that existed for this envelope alone.
    let swift = read("apps/ios/Sources/Services/CryptoService.swift");
    assert!(
        swift.contains("aadHex: try keyWrapAad(CryptoLabels.LABEL_HUB_KEY_WRAP)"),
        "CryptoService.loadHubKey no longer binds keyWrapAad(LABEL_HUB_KEY_WRAP)"
    );
    assert!(
        !swift.contains("private let noAad"),
        "the `noAad` constant is back; it existed for the hub-key envelope, \
         whose empty AAD was the #1631 defect rather than an exemption"
    );

    // Android's reader is Rust: `mobile_load_hub_key` must not pass `&[]`.
    let ffi = read("packages/crypto/src/ffi_v3.rs");
    let load = ffi
        .split_once("pub fn mobile_load_hub_key")
        .expect("mobile_load_hub_key is gone — Android's hub-key reader moved")
        .1;
    let body = load.split("\n}\n").next().unwrap_or_default();
    assert!(
        body.contains("key_wrap_aad(crate::labels::LABEL_HUB_KEY_WRAP)"),
        "mobile_load_hub_key no longer binds key_wrap_aad(LABEL_HUB_KEY_WRAP)"
    );
}
