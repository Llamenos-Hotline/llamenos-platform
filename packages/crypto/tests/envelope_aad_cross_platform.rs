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

/// Notes, files, and contact identifiers are canonical-AAD envelopes on every
/// platform: `content_aad(label)` on the content layer, `key_wrap_aad(label)`
/// on the key wrap. A call site passing an empty AAD beside one of those
/// labels is the #1517-family defect recurring — writer and reader look
/// self-consistent on one platform, and every other platform fails the tag
/// check with no hint of why. Hub-key and PUK envelopes are exempt: every
/// implementation of those passes empty (or the PUK per-device AAD) by
/// agreement, so the pair interoperates.
#[test]
fn mobile_never_seals_canonical_envelopes_with_empty_aad() {
    const CANONICAL_LABELS: [&str; 5] = [
        "LABEL_NOTE_KEY",
        "LABEL_FILE_KEY",
        "LABEL_FILE_METADATA",
        "LABEL_CONTACT_ID",
        "LABEL_CONTACT_PROFILE",
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
/// contact identifiers. A crypto entry point invoked on the same source line
/// as one of the canonical labels must not pass an empty AAD literal — the
/// pre-fix shape of this line was `hpkeSealKey(keyHex, pub, LABEL_NOTE_KEY, '')`.
#[test]
fn desktop_never_seals_canonical_envelopes_with_empty_aad() {
    const CANONICAL_LABELS: [&str; 5] = [
        "LABEL_NOTE_KEY",
        "LABEL_FILE_KEY",
        "LABEL_FILE_METADATA",
        "LABEL_CONTACT_ID",
        "LABEL_CONTACT_PROFILE",
    ];
    const ENCRYPT_FNS: [&str; 4] = [
        "hpkeSealKey",
        "hpkeOpenKeyFromState",
        "aesGcmEncrypt",
        "aesGcmDecrypt",
    ];
    let files = [
        "src/client/lib/platform.ts",
        "src/client/lib/file-crypto.ts",
        "src/client/components/signal-notification-section.tsx",
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
