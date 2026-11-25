//! Bindgen over the vendored, sha256-pinned liblinphone SDK (#1770, plan Task 2).
//!
//! The SDK is installed by `scripts/fetch-linphone-sdk.sh <target>` into
//! `apps/desktop/vendor/linphone-sdk/<target>/`. This script refuses to build
//! when that tree is absent OR when the digest it was verified against
//! (`.sdk-sha256`, written by the fetch script) is not the digest pinned for the
//! target in `apps/desktop/linphone-sdk-checksums.txt` — a stale vendored tree
//! from an older pin is a different library, not a cache hit.
//!
//! liblinphone is never built from source here (spec §3.1).

use std::path::{Path, PathBuf};

/// The checksums-file target name for the host we are building FOR.
fn target_name() -> &'static str {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    match (os.as_str(), arch.as_str()) {
        ("linux", "x86_64") => "linux-x86_64",
        ("macos", "aarch64") => "macos-arm64",
        ("windows", "x86_64") => "windows-x86_64",
        (os, arch) => panic!(
            "llamenos-voice-sys: no pinned liblinphone SDK for {os}/{arch} \
             (see apps/desktop/linphone-sdk-checksums.txt)"
        ),
    }
}

/// The sha256 pinned for `target` — the third field of its single
/// non-comment line. Mirrors scripts/fetch-linphone-sdk.sh's parse.
fn pinned_digest(checksums: &Path, target: &str) -> Option<String> {
    let text = std::fs::read_to_string(checksums).ok()?;
    let mut hits = text
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .map(|l| l.split_whitespace().collect::<Vec<_>>())
        .filter(|f| f.first() == Some(&target));
    let fields = hits.next()?;
    if hits.next().is_some() || fields.len() != 3 {
        return None;
    }
    Some(fields[2].to_string())
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let desktop = manifest.join("../..");
    let target = target_name();
    let checksums = desktop.join("linphone-sdk-checksums.txt");
    let sdk = desktop.join("vendor/linphone-sdk").join(target);

    println!("cargo:rerun-if-changed=wrapper.h");
    println!("cargo:rerun-if-changed={}", checksums.display());
    println!(
        "cargo:rerun-if-changed={}",
        sdk.join(".sdk-sha256").display()
    );

    let fetch_hint = format!("run scripts/fetch-linphone-sdk.sh {target} first");
    let pinned = pinned_digest(&checksums, target).unwrap_or_else(|| {
        panic!(
            "llamenos-voice-sys: no single valid pin for {target} in {}",
            checksums.display()
        )
    });
    let installed = std::fs::read_to_string(sdk.join(".sdk-sha256")).unwrap_or_else(|_| {
        panic!(
            "llamenos-voice-sys: liblinphone SDK missing at {} — {fetch_hint}",
            sdk.display()
        )
    });
    assert_eq!(
        installed.trim(),
        pinned,
        "llamenos-voice-sys: the vendored SDK at {} was verified against a different pin — {fetch_hint}",
        sdk.display(),
    );

    let mut builder = bindgen::Builder::default()
        .header(manifest.join("wrapper.h").to_string_lossy())
        .allowlist_function("linphone_.*")
        .allowlist_function("bctbx_list_(next|get_data|size|free|free_with_data)")
        .allowlist_type("_?Linphone.*")
        .allowlist_var("Linphone.*")
        // Newtype enums, never Rust enums: a C value outside the variants a
        // Rust enum declares is undefined behaviour the moment it is read.
        .default_enum_style(bindgen::EnumVariation::NewType {
            is_bitfield: false,
            is_global: false,
        })
        .prepend_enum_name(false)
        .derive_default(true)
        .layout_tests(false)
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()));

    let lib_dir;
    if target == "macos-arm64" {
        // Frameworks layout: <linphone/core.h> resolves through -F.
        let frameworks = sdk.join("Frameworks");
        builder = builder.clang_arg(format!("-F{}", frameworks.display()));
        println!("cargo:rustc-link-search=framework={}", frameworks.display());
        println!("cargo:rustc-link-lib=framework=linphone");
        // bctbx_list_* (the lists liblinphone hands back) live in bctoolbox.
        println!("cargo:rustc-link-lib=framework=bctoolbox");
        lib_dir = frameworks;
    } else {
        let include = sdk.join("include");
        assert!(
            include.join("linphone/core.h").is_file(),
            "llamenos-voice-sys: {} has no include/linphone/core.h — {fetch_hint}",
            sdk.display()
        );
        builder = builder.clang_arg(format!("-I{}", include.display()));
        lib_dir = sdk.join("lib");
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        // Windows ships the import library as liblinphone.lib; Linux as liblinphone.so.
        let name = if target == "windows-x86_64" {
            "liblinphone"
        } else {
            "linphone"
        };
        println!("cargo:rustc-link-lib=dylib={name}");
        // bctbx_list_* (the lists liblinphone hands back) live in bctoolbox.
        println!("cargo:rustc-link-lib=dylib=bctoolbox");
    }

    // Exposed to dependents' build scripts (`links = "linphone"`).
    println!("cargo:sdk_root={}", sdk.display());
    println!("cargo:lib_dir={}", lib_dir.display());

    let bindings = builder
        .generate()
        .expect("llamenos-voice-sys: bindgen over linphone/core.h failed");
    bindings
        .write_to_file(PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("bindings.rs"))
        .expect("llamenos-voice-sys: could not write bindings.rs");
}
