//! Saving the encrypted account backup to disk (#2111).
//!
//! The webview used to hand the backup to an `<a download>` click. On the Linux
//! WebKitGTK webview that shows no dialog and no path: the engine silently wrote
//! `backup-<rand>.json` into the process's current directory, so the user ended
//! onboarding unable to find — or be sure they had — the one file that restores
//! the account besides the recovery key. The app could not tell where, or
//! whether, the file landed.
//!
//! The write now happens here, in Rust, behind a native save dialog the USER
//! answers:
//!
//! * the **location is the user's choice** (`tauri-plugin-dialog`, rendered
//!   outside the webview's DOM, so a compromised renderer cannot pick a path);
//! * the webview holds **no `fs` plugin grant** — this command is the only way it
//!   can put a file on disk, and it only writes what [`validate_backup_contents`]
//!   accepts: a v4 backup container, size-capped. It is not a generic writer;
//! * the result is the **absolute path actually written**, which the UI shows, or
//!   `None` when the user dismissed the dialog (nothing was written). Callers
//!   must treat only `Some(path)` as "backup saved".

use rand::RngCore;
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Container version this build writes. Must match `BACKUP_FORMAT_VERSION` in
/// `packages/crypto/src/backup.rs` and `src/client/lib/backup.ts`.
const BACKUP_FORMAT_VERSION: u64 = 4;

/// A real backup is a few hundred bytes (two small ciphertext blocks); anything
/// near this cap is not a backup and must not be written.
const MAX_BACKUP_BYTES: usize = 16 * 1024;

/// Refuse anything that is not a backup container, so [`save_backup_file`] cannot
/// be used by injected script to write arbitrary content to a user-approved path.
fn validate_backup_contents(contents: &str) -> Result<(), String> {
    if contents.len() > MAX_BACKUP_BYTES {
        return Err("refusing to save: this is not an account backup (too large)".to_string());
    }
    let value: Value = serde_json::from_str(contents)
        .map_err(|_| "refusing to save: this is not an account backup (not JSON)".to_string())?;
    let obj = value
        .as_object()
        .ok_or_else(|| "refusing to save: this is not an account backup".to_string())?;
    if obj.get("v").and_then(Value::as_u64) != Some(BACKUP_FORMAT_VERSION) {
        return Err("refusing to save: unsupported backup version".to_string());
    }
    // Both protected blocks must be present — a container with only one cannot
    // restore the account by both of the credentials the user was told about.
    for block in ["d", "r"] {
        if !obj.get(block).is_some_and(Value::is_object) {
            return Err("refusing to save: the backup is incomplete".to_string());
        }
    }
    Ok(())
}

/// Compact, random filename — nothing in the name identifies the app or user.
fn suggested_file_name() -> String {
    let mut suffix = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut suffix);
    format!("backup-{}.json", hex::encode(suffix))
}

/// Ask the user where to save the encrypted backup and write it there.
///
/// Returns `Ok(Some(path))` once the file is on disk, `Ok(None)` if the user
/// dismissed the dialog (nothing written), and `Err` if the content is not a
/// backup or the write failed — the caller must not mark the backup as saved
/// in the latter two cases.
#[tauri::command]
pub async fn save_backup_file(app: AppHandle, contents: String) -> Result<Option<String>, String> {
    validate_backup_contents(&contents)?;

    // Both calls block (a modal dialog; a disk write), so keep them off the
    // async executor threads.
    tauri::async_runtime::spawn_blocking(move || {
        let Some(chosen) = app
            .dialog()
            .file()
            .set_file_name(suggested_file_name())
            .add_filter("Encrypted backup", &["json"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = chosen
            .into_path()
            .map_err(|e| format!("could not use the chosen location: {e}"))?;
        std::fs::write(&path, contents.as_bytes())
            .map_err(|e| format!("could not write {}: {e}", path.display()))?;
        Ok(Some(path.display().to_string()))
    })
    .await
    .map_err(|e| format!("backup save task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str =
        r#"{"v":4,"id":"e49cd3","t":1700000000,"d":{"kv":2,"c":"00"},"r":{"kv":1,"c":"00"}}"#;

    #[test]
    fn accepts_a_v4_container() {
        assert!(validate_backup_contents(VALID).is_ok());
    }

    #[test]
    fn rejects_anything_that_is_not_a_backup() {
        for bad in [
            "not json",
            "[]",
            "\"v\"",
            r#"{"v":3,"d":{},"r":{}}"#,
            r#"{"d":{},"r":{}}"#,
            r#"{"v":4,"d":{}}"#,
            r#"{"v":4,"d":"x","r":"y"}"#,
        ] {
            assert!(validate_backup_contents(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_oversized_content() {
        let big = format!(
            r#"{{"v":4,"d":{{}},"r":{{}},"pad":"{}"}}"#,
            "a".repeat(MAX_BACKUP_BYTES)
        );
        assert!(validate_backup_contents(&big).is_err());
    }

    #[test]
    fn suggested_name_is_random_and_anonymous() {
        let a = suggested_file_name();
        assert!(a.starts_with("backup-") && a.ends_with(".json"), "{a}");
        assert_eq!(a.len(), "backup-".len() + 8 + ".json".len());
        assert_ne!(a, suggested_file_name());
    }
}
