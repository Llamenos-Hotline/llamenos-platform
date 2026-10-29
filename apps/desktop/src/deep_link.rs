//! `llamenos://hub-invite?code=<uuid>` deep links (#1128).
//!
//! The OS hands a clicked invite link to this process — on Linux and Windows as
//! a command-line argument to a second instance, which `tauri-plugin-single-instance`
//! (built with its `deep-link` feature) forwards here, so `on_open_url` fires on
//! the instance that is already running.
//!
//! Every URL is untrusted input from any program on the machine, so this is an
//! allowlist, not a router: only the invite host is accepted, and only the code
//! survives parsing. The code is a bearer token for an invite and nothing more —
//! a link cannot name a server, choose a screen or carry anything else into the
//! webview. The webview is told that an invite is waiting (a payload-free
//! event) and fetches the code with `take_pending_invite`, which hands it over
//! once.
//!
//! The link shape matches what iOS accepts (`InviteCodeParser` in
//! apps/ios/Sources/Services/InviteEnrollmentService.swift): `code=` or `token=`.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use url::Url;

/// Native → webview event: an invite link arrived; call `take_pending_invite`.
pub const INVITE_EVENT: &str = "invite-deep-link";

const SCHEME: &str = "llamenos";
const INVITE_HOST: &str = "hub-invite";

/// The most recent invite code a deep link delivered, until the webview takes it.
#[derive(Default)]
pub struct PendingInvite(Mutex<Option<String>>);

impl PendingInvite {
    fn set(&self, code: String) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(code);
    }

    fn take(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// Canonical (lowercase) form of `value` if it is a UUID — the only shape the
/// server issues invite codes in (`crypto.randomUUID()`).
fn canonical_invite_code(value: &str) -> Option<String> {
    let code = value.to_ascii_lowercase();
    let groups: Vec<&str> = code.split('-').collect();
    let lengths = [8usize, 4, 4, 4, 12];
    if groups.len() != lengths.len() {
        return None;
    }
    let well_formed = groups
        .iter()
        .zip(lengths)
        .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()));
    well_formed.then_some(code)
}

/// The invite code in `url`, or `None` if it is not a well-formed invite link.
pub fn parse_invite_url(url: &Url) -> Option<String> {
    if url.scheme() != SCHEME || url.host_str() != Some(INVITE_HOST) || url.port().is_some() {
        return None;
    }
    if !matches!(url.path(), "" | "/") {
        return None;
    }
    url.query_pairs()
        .find(|(name, _)| name == "code" || name == "token")
        .and_then(|(_, value)| canonical_invite_code(&value))
}

/// Accept the invite links among `urls`, raise the window and tell the webview.
pub fn handle_urls<R: Runtime>(app: &AppHandle<R>, urls: &[Url]) {
    let Some(code) = urls.iter().find_map(parse_invite_url) else {
        if !urls.is_empty() {
            tauri_plugin_log::log::warn!("ignored a deep link that is not an invite link");
        }
        return;
    };
    app.state::<PendingInvite>().set(code);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let _ = app.emit(INVITE_EVENT, ());
}

/// Hand the waiting invite code to the webview, once.
#[tauri::command]
pub fn take_pending_invite(state: State<'_, PendingInvite>) -> Option<String> {
    state.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODE: &str = "3f2b8c1e-9a4d-4e6f-b1c2-7d8e9f0a1b2c";

    fn parse(s: &str) -> Option<String> {
        parse_invite_url(&Url::parse(s).expect("test URL parses"))
    }

    #[test]
    fn accepts_an_invite_link_with_code_or_token() {
        assert_eq!(
            parse(&format!("llamenos://hub-invite?code={CODE}")).as_deref(),
            Some(CODE)
        );
        assert_eq!(
            parse(&format!("llamenos://hub-invite/?token={CODE}")).as_deref(),
            Some(CODE)
        );
    }

    #[test]
    fn canonicalises_an_upper_case_code() {
        let upper = CODE.to_ascii_uppercase();
        assert_eq!(
            parse(&format!("llamenos://hub-invite?code={upper}")).as_deref(),
            Some(CODE)
        );
    }

    #[test]
    fn refuses_anything_that_is_not_an_invite_link() {
        for url in [
            format!("https://hub-invite?code={CODE}"),
            format!("llamenos://oauth/callback?code={CODE}"),
            format!("llamenos://hub-invite/extra?code={CODE}"),
            format!("llamenos://hub-invite:80?code={CODE}"),
            "llamenos://hub-invite?code=not-a-code".to_string(),
            "llamenos://hub-invite?code=".to_string(),
            "llamenos://hub-invite".to_string(),
            format!("llamenos://hub-invite?code={CODE}x"),
            format!("llamenos://hub-invite?code={}", CODE.replace('-', "")),
        ] {
            assert_eq!(parse(&url), None, "{url} must be refused");
        }
    }

    #[test]
    fn the_code_is_handed_over_once() {
        let pending = PendingInvite::default();
        pending.set(CODE.to_string());
        assert_eq!(pending.take().as_deref(), Some(CODE));
        assert_eq!(pending.take(), None);
    }
}
