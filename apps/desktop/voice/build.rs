//! Hands the vendored SDK's resource directory (belr grammars, sounds) to this
//! crate's own tests and the Tier 2 harness, as `LLAMENOS_VOICE_SDK_SHARE`.
//! The paths come from llamenos-voice-sys (`links = "linphone"`), which has
//! already refused a missing or stale vendored tree.
fn main() {
    let root =
        std::env::var("DEP_LINPHONE_SDK_ROOT").expect("llamenos-voice-sys exports its SDK root");
    let lib =
        std::env::var("DEP_LINPHONE_LIB_DIR").expect("llamenos-voice-sys exports its lib dir");
    let share = std::path::Path::new(&root).join("share");
    println!(
        "cargo:rustc-env=LLAMENOS_VOICE_SDK_SHARE={}",
        share.display()
    );
    println!("cargo:rustc-env=LLAMENOS_VOICE_SDK_LIB={lib}");
}
