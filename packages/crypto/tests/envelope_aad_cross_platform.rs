//! No host builds an envelope by hand (spec D1, #2974 stage 0).
//!
//! An HPKE envelope's label and AAD are the crate's: every platform names a
//! [`Shape`] and the crate maps it to the label it seals under (HPKE `info`), the
//! key-wrap AAD and the content AAD. Before stage 0 each host passed all three
//! itself — `mobileLabelToId`, the desktop's `toIpcEnvelope`, Android's
//! `LABEL_ID_*` table, iOS's `labelId: 0`, `mobileContentAadHex` /
//! `mobileKeyWrapAadHex` — and every copy was a place for one client to drift
//! from the rest with nothing failing until a reader on another platform did
//! (#1517, #1520, #1631, #1927, #2499).
//!
//! Those entry points are gone from the crate, so a host cannot call them. What
//! a host still *can* do is re-spell the rule: name a shape's label constant or
//! its string, a `labelId`, or the `:key-wrap` suffix, and feed it to some other
//! primitive. This gate scans every production host source — the webview, the
//! server, the desktop shell, iOS and Android — for exactly that. Comment lines
//! and Rust `#[cfg(test)]` modules are not production code and are skipped; the
//! few code lines that use one of these labels for something that is not an
//! HPKE envelope are listed in [`ALLOWED`] with the reason.
//!
//! The walk is over the file tree, not `git ls-files`: `fleet/verify` runs the
//! suites in a `.git`-less export.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use llamenos_core::Shape;

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

/// Production host source roots.
const ROOTS: &[&str] = &[
    "src/client",
    "apps/worker",
    "apps/desktop/src",
    "apps/ios/Sources",
    "apps/android/app/src/main",
    "packages/shared",
];

/// Directories that hold no production host source of their own.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "__tests__",
    "generated",
    "target",
    "build",
    "dist",
];

/// Files under [`ROOTS`] that are not host-authored production code.
const SKIP_FILES: &[(&str, &str)] = &[
    (
        "apps/android/app/src/main/java/org/llamenos/core/llamenos_core.kt",
        "the generated UniFFI binding: its doc comments are the crate's own",
    ),
    (
        "packages/shared/crypto-labels.ts",
        "the generated label constants",
    ),
    (
        "packages/shared/envelope-aad.ts",
        "test-side only: the JS mirror's AAD rule, pinned against the crate's vectors; \
         production code may not import it (checked below)",
    ),
];

/// Code lines that name a shape's label for something that is not an HPKE
/// envelope. `(file, token, reason)`. Adding an entry is a deliberate act a
/// reviewer will see.
const ALLOWED: &[(&str, &str, &str)] = &[
    (
        "apps/worker/lib/crypto.ts",
        "LABEL_CONTACT_ID",
        "server-KEK at-rest encryption of a contact identifier (serverEncrypt), not an HPKE envelope",
    ),
    (
        "apps/worker/messaging/signal/queue.ts",
        "LABEL_CONTACT_ID",
        "Signal retry queue: server-KEK at-rest encryption and an HMAC lookup key, not an HPKE envelope",
    ),
    (
        "apps/worker/messaging/signal/queue.ts",
        "LABEL_MESSAGE",
        "Signal retry queue: server-KEK at-rest encryption of the queued body, not an HPKE envelope",
    ),
    (
        "apps/desktop/src/crypto.rs",
        "LABEL_RECOVERY_SHARE_CONTRIBUTE",
        "the recovery contribution's signed message prefix (an Ed25519 signature, not an envelope); \
         its cross-platform format is stage 1's (D14)",
    ),
];

/// The labels the crate's shapes seal under, read out of `Shape::label` in
/// `src/shape.rs` (crate-private by design, so read as source) and checked
/// against `Shape::ALL` so a shape added without a label match fails here.
fn shape_label_names() -> Vec<String> {
    let src = read("packages/crypto/src/shape.rs");
    let start = src
        .find("const fn label(self)")
        .expect("Shape::label is gone from src/shape.rs");
    let body = &src[start..];
    let body = &body[..body.find("\n    }\n").expect("unterminated Shape::label")];
    let names: BTreeSet<String> = body
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| w.starts_with("LABEL_"))
        .map(str::to_string)
        .collect();
    assert_eq!(
        names.len(),
        Shape::ALL.len(),
        "Shape::label does not name one distinct label per shape"
    );
    names.into_iter().collect()
}

/// `name → string` for every label, from the source of truth for label strings.
fn label_strings() -> serde_json::Map<String, serde_json::Value> {
    let json: serde_json::Value =
        serde_json::from_str(&read("packages/protocol/crypto-labels.json"))
            .expect("crypto-labels.json");
    json["labels"]
        .as_object()
        .expect("crypto-labels.json has no labels object")
        .clone()
}

/// Entry points and spellings the shape API replaced. None may come back.
const REMOVED: &[&str] = &[
    "labelId",
    "label_id",
    "LABEL_ID_",
    "mobileLabelToId",
    "mobileHexToBase64url",
    "mobileBase64urlToHex",
    "mobileContentAadHex",
    "mobileKeyWrapAadHex",
    "mobileHpke",
    "mobileSymmetricEncrypt",
    "mobileSymmetricDecrypt",
    "toIpcEnvelope",
    "decryptHubEvent",
    "decrypt_hub_event",
    "decrypt_server_event_hex",
    ":key-wrap",
    "envelope-aad'",
    "envelope-aad\"",
];

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `token` occurs in `line` as a whole token: an identifier-shaped token must not
/// continue into a longer identifier (`LABEL_MESSAGE` is not `LABEL_MESSAGE_X`),
/// and a label string must not continue into a longer label.
fn occurs(line: &str, token: &str) -> bool {
    let bytes = line.as_bytes();
    let ident = token.bytes().all(is_ident_byte);
    let label = token.starts_with("llamenos:");
    let mut from = 0;
    while let Some(i) = line[from..].find(token) {
        let at = from + i;
        let end = at + token.len();
        let before_ok = !ident || at == 0 || !is_ident_byte(bytes[at - 1]);
        let after_ok = match bytes.get(end) {
            None => true,
            Some(&b) if ident => !is_ident_byte(b),
            Some(&b) if label => !(b.is_ascii_alphanumeric() || b == b'-' || b == b':'),
            Some(_) => true,
        };
        if before_ok && after_ok {
            return true;
        }
        from = at + 1;
    }
    false
}

fn is_comment_line(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("//") || t.starts_with("/*") || t.starts_with('*')
}

/// The production lines of a source file: comment lines dropped, and for Rust
/// every `#[cfg(test)]` item (a test module, or a test-only function) dropped by
/// brace depth.
fn production_lines(rel: &str, text: &str) -> Vec<(usize, String)> {
    let rust = rel.ends_with(".rs");
    let mut out = Vec::new();
    let mut skip_depth: Option<i64> = None;
    let mut pending_cfg_test = false;
    let mut depth: i64 = 0;
    for (n, line) in text.lines().enumerate() {
        let opens = line.matches('{').count() as i64;
        let closes = line.matches('}').count() as i64;
        if rust {
            if line.trim_start().starts_with("#[cfg(test)]") {
                pending_cfg_test = true;
                continue;
            }
            if pending_cfg_test && skip_depth.is_none() && !line.trim_start().starts_with("#[") {
                pending_cfg_test = false;
                if opens > closes {
                    skip_depth = Some(depth);
                } else {
                    // A one-line test-only item (`use …;`, `mod x;`).
                    depth += opens - closes;
                    continue;
                }
            }
        }
        depth += opens - closes;
        if let Some(d) = skip_depth {
            if depth <= d {
                skip_depth = None;
            }
            continue;
        }
        if is_comment_line(line) {
            continue;
        }
        out.push((n + 1, line.to_string()));
    }
    out
}

fn walk(dir: &Path, root: &Path, files: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) {
                walk(&path, root, files);
            }
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !matches!(ext, "ts" | "tsx" | "rs" | "kt" | "swift") {
            continue;
        }
        if name.contains(".test.") || name.contains(".spec.") {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if SKIP_FILES.iter().any(|(f, _)| *f == rel) {
            continue;
        }
        files.push(rel);
    }
}

fn host_files() -> Vec<String> {
    let root = repo_root();
    let mut files = Vec::new();
    for r in ROOTS {
        walk(&root.join(r), &root, &mut files);
    }
    files.sort();
    files
}

/// Every token this gate refuses in production host code.
fn forbidden_tokens() -> Vec<String> {
    let strings = label_strings();
    let mut tokens: Vec<String> = Vec::new();
    for name in shape_label_names() {
        let value = strings
            .get(&name)
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("{name} is not in crypto-labels.json"));
        tokens.push(value.to_string());
        tokens.push(name);
    }
    tokens.extend(REMOVED.iter().map(|s| s.to_string()));
    tokens
}

#[test]
fn no_production_host_source_builds_an_envelope_by_hand() {
    let tokens = forbidden_tokens();
    let files = host_files();
    // A walk that found nothing would make every assertion below vacuous.
    assert!(
        files.len() > 500,
        "scanned only {} host files — wrong roots?",
        files.len()
    );

    let mut offenders = Vec::new();
    for rel in &files {
        let text = read(rel);
        for (n, line) in production_lines(rel, &text) {
            for token in &tokens {
                if !occurs(&line, token) {
                    continue;
                }
                if ALLOWED.iter().any(|(f, t, _)| *f == rel && *t == token) {
                    continue;
                }
                offenders.push(format!("{rel}:{n}: `{token}` — {}", line.trim()));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "production host code names an envelope label, a labelId, an AAD rule or a removed \
         entry point. Seal and open by Shape (shapeSeal / mobileShapeSeal / shape_seal) and let \
         the crate fix the label and AAD — or, if the use is not an HPKE envelope, add it to \
         ALLOWED with the reason:\n{}",
        offenders.join("\n")
    );
}

/// The scanner itself: a forbidden token on a code line is caught, and the same
/// token in a comment or a Rust test module is not.
#[test]
fn the_scanner_sees_code_and_skips_comments_and_test_modules() {
    let src = "\
fn a() { seal(LABEL_NOTE_KEY) }
// LABEL_NOTE_KEY in a comment
#[cfg(test)]
mod tests {
    fn b() { seal(LABEL_NOTE_KEY) }
}
fn c() { let labelId = 1; }
";
    let lines = production_lines("x.rs", src);
    let hits: Vec<usize> = lines
        .iter()
        .filter(|(_, l)| occurs(l, "LABEL_NOTE_KEY") || occurs(l, "labelId"))
        .map(|(n, _)| *n)
        .collect();
    assert_eq!(hits, vec![1, 7]);
    assert!(!occurs("LABEL_NOTE_KEY_X", "LABEL_NOTE_KEY"));
    assert!(occurs("'llamenos:message'", "llamenos:message"));
    assert!(!occurs("'llamenos:message-x'", "llamenos:message"));
}

#[test]
fn every_exception_is_still_needed() {
    // An allowlist that silently rots stops describing the real exceptions.
    for (file, token, reason) in ALLOWED {
        let text = read(file);
        assert!(
            production_lines(file, &text)
                .iter()
                .any(|(_, l)| occurs(l, token)),
            "{file} no longer uses `{token}` ({reason}) — drop it from ALLOWED"
        );
    }
    for (file, reason) in SKIP_FILES {
        assert!(
            repo_root().join(file).exists(),
            "{file} ({reason}) is gone — drop it from SKIP_FILES"
        );
    }
}

/// The tracked bindings are the shape API and nothing older. A stale tracked
/// binding is indistinguishable from a correct one until it is loaded; full
/// freshness is `scripts/kotlin-bindings.sh check` and `generate-bindings.sh`
/// (CI's crypto-tests job), this pins the stage-0 surface.
#[test]
fn the_tracked_bindings_expose_the_shape_api_and_nothing_older() {
    for (rel, sigs) in [
        (
            "apps/android/app/src/main/java/org/llamenos/core/llamenos_core.kt",
            [
                "fun `mobileShapeSeal`(",
                "fun `mobileShapeOpen`(",
                "fun `mobileOpenServerEvent`(",
                "fun `mobileSetServerEventKeys`(",
            ],
        ),
        (
            "packages/crypto/bindings/swift/LlamenosCore.swift",
            [
                "func mobileShapeSeal(",
                "func mobileShapeOpen(",
                "func mobileOpenServerEvent(",
                "func mobileSetServerEventKeys(",
            ],
        ),
    ] {
        let text = read(rel);
        for sig in sigs {
            assert!(
                text.contains(sig),
                "{rel} lacks {sig} — regenerate the bindings"
            );
        }
        for token in REMOVED {
            assert!(
                !text
                    .lines()
                    .any(|l| !is_comment_line(l) && occurs(l, token)),
                "{rel} still exposes `{token}` — regenerate the bindings"
            );
        }
    }
}
