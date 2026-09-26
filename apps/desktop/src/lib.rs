mod api_config;
mod cert_pin;
mod crypto;
mod hub_keys;
mod net;

use tauri::{Emitter, Manager};

use crate::crypto::CryptoState;
use crate::net::{PinnedNet, ProbeLimiter, WsRegistry};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_stronghold::Builder::new(|password| {
                // PBKDF2-SHA256 with 600K iterations — matches web app's key derivation.
                // Domain-separated salt prevents cross-application brute-force reuse.
                use hmac::Hmac;
                use pbkdf2::pbkdf2;
                use sha2::Sha256;

                let salt = llamenos_core::labels::LABEL_STRONGHOLD.as_bytes();
                let mut kek = vec![0u8; 32];
                pbkdf2::<Hmac<Sha256>>(password.as_bytes(), salt, 600_000, &mut kek)
                    .expect("PBKDF2 derivation failed");
                kek
            })
            .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus existing window when second instance launched
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                // Visual feedback: unminimize if minimized
                let _ = window.unminimize();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Native confirmation dialogs (#788) — used only from Rust
        // (`api_config::api_config_request_clear`), never exposed to the
        // webview as its own IPC command.
        .plugin(tauri_plugin_dialog::init());

    // Updater disabled for Flatpak builds (Flatpak has its own update mechanism)
    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        // Register CryptoState as managed state (v3: Ed25519 + X25519 device keys)
        .manage(CryptoState::new())
        // Registry of live Rust-proxied WebSocket connections (#739)
        .manage(WsRegistry::default())
        // One-per-second budget for first-run health probes (#739)
        .manage(ProbeLimiter::default())
        // Pinned HTTP client + WebSocket TLS connector for the configured
        // backend (#775) — populated below, once a backend is configured.
        .manage(PinnedNet::default())
        // One-time confirmation token for api_config_clear (#788)
        .manage(api_config::ClearConfirmState::default())
        .setup(|app| {
            // Rehydrate the pinned TLS client/connector from whatever backend
            // was already configured on a previous run (#775). Must happen
            // before the webview can call `net_fetch`/`net_ws_connect`.
            if let Err(e) = net::load_or_reset_pinned_net(app.handle()) {
                tauri_plugin_log::log::warn!("could not load pinned backend config: {e}");
            }

            // System tray setup
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
            use tauri::tray::TrayIconBuilder;

            let show_hide = MenuItem::with_id(app, "show_hide", "Show / Hide", true, None::<&str>)?;
            #[cfg(feature = "updater")]
            let check_updates = MenuItem::with_id(
                app,
                "check_updates",
                "Check for Updates\u{2026}",
                true,
                None::<&str>,
            )?;
            let about = MenuItem::with_id(
                app,
                "about",
                format!("About Hotline v{}", env!("CARGO_PKG_VERSION")),
                true,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Hotline", true, None::<&str>)?;

            #[cfg(feature = "updater")]
            let menu = Menu::with_items(
                app,
                &[
                    &show_hide,
                    &separator,
                    &check_updates,
                    &about,
                    &separator,
                    &quit,
                ],
            )?;
            #[cfg(not(feature = "updater"))]
            let menu = Menu::with_items(app, &[&show_hide, &separator, &about, &separator, &quit])?;

            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Hotline")
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show_hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = window.unminimize();
                            }
                        }
                    }
                    #[cfg(feature = "updater")]
                    "check_updates" => {
                        // Emit event to frontend so the UI can show update progress
                        let _ = app.emit("check-for-updates", ());
                    }
                    "about" => {
                        // Show the main window with focus (about info shown in-app)
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = app.emit("navigate", "/settings");
                        }
                    }
                    "quit" => {
                        // Zeroize crypto state before exit
                        if let Some(state) = app.try_state::<CryptoState>() {
                            state.lock();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.unminimize();
                        }
                    }
                })
                .build(app)?;

            // Lock crypto state when window is destroyed (app closing)
            let app_handle = app.handle().clone();
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Destroyed = event {
                        if let Some(state) = app_handle.try_state::<CryptoState>() {
                            state.lock();
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Device key management (secrets stay in Rust)
            crypto::device_generate_and_load,
            crypto::unlock_with_pin,
            crypto::lock_crypto,
            crypto::is_crypto_unlocked,
            crypto::get_device_pubkeys,
            // Auth (Ed25519)
            crypto::create_auth_token_from_state,
            // Ed25519 signing/verification
            crypto::ed25519_sign_from_state,
            crypto::ed25519_verify,
            // HPKE envelope encryption
            crypto::hpke_seal,
            crypto::hpke_open_from_state,
            crypto::hpke_seal_key,
            crypto::hpke_open_key_from_state,
            // PUK (Per-User Key — seed stays in Rust CryptoState)
            crypto::puk_create_from_state,
            crypto::puk_rotate_from_state,
            crypto::puk_unwrap_seed_from_state,
            // Sigchain
            crypto::sigchain_create_link_from_state,
            crypto::sigchain_verify,
            crypto::sigchain_verify_link,
            // SFrame key derivation
            crypto::sframe_derive_key,
            // Hub key management (key stays in Rust CryptoState)
            crypto::hpke_unwrap_and_set_hub_key,
            crypto::forget_hub_key,
            crypto::generate_pending_hub_key,
            crypto::commit_pending_hub_key,
            crypto::discard_pending_hub_key,
            crypto::wrap_hub_key_for_member,
            crypto::set_server_event_keys,
            crypto::decrypt_hub_event,
            crypto::decrypt_server_event,
            crypto::encrypt_hub_field,
            crypto::decrypt_hub_field,
            // SAS emoji verification
            crypto::derive_sas,
            // Shamir secret sharing (only stateless verification — split/combine are internal)
            crypto::shamir_commit,
            crypto::shamir_verify,
            // H16: Recovery group key isolation (combine+decrypt in Rust only)
            crypto::recovery_group_create,
            crypto::recovery_group_reconstruct_from_shares,
            crypto::recovery_group_decrypt,
            // C06: Missing IPC commands
            crypto::device_import_and_load,
            crypto::generate_ephemeral_ed25519,
            crypto::generate_backup_from_state,
            // H17: Stronghold vault file wipe
            crypto::wipe_keys,
            // Device provisioning (seed NEVER enters the webview)
            crypto::provision_encrypt_for_device,
            crypto::provision_create_session,
            crypto::provision_compute_sas,
            crypto::provision_decrypt_and_import,
            // Configured backend address (#738) — persisted and validated in Rust;
            // the webview holds no store-plugin permission for it.
            api_config::api_config_get,
            api_config::api_config_set,
            api_config::api_config_request_clear,
            api_config::api_config_clear,
            // Runtime-enforced network egress (#739) — the webview's CSP connect-src
            // allows only `ipc:`; all HTTP/WS traffic to the configured backend goes
            // through these commands instead of a browser fetch/WebSocket.
            net::net_fetch,
            net::net_probe_health,
            net::net_ws_connect,
            net::net_ws_send,
            net::net_ws_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
