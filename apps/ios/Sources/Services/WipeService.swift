import Foundation

/// Centralized data wipe service — single source of truth for all destructive cleanup.
/// Used by panic wipe, remote device wipe, and logout flows.
///
/// Three wipe levels:
/// - `wipeAll()`: Full destructive wipe (panic wipe, remote device wipe). Clears everything.
/// - `logout()`: Session cleanup only. Preserves device keys, crash logs, and caches for re-login.
final class WipeService {
    private let keychainService: KeychainService
    private let cryptoService: CryptoService
    private let wakeKeyService: WakeKeyService
    private let offlineQueue: OfflineQueue
    private let crashReportingService: CrashReportingService
    private let webSocketService: WebSocketService

    init(
        keychainService: KeychainService,
        cryptoService: CryptoService,
        wakeKeyService: WakeKeyService,
        offlineQueue: OfflineQueue,
        crashReportingService: CrashReportingService,
        webSocketService: WebSocketService
    ) {
        self.keychainService = keychainService
        self.cryptoService = cryptoService
        self.wakeKeyService = wakeKeyService
        self.offlineQueue = offlineQueue
        self.crashReportingService = crashReportingService
        self.webSocketService = webSocketService
    }

    /// Full destructive wipe — used by panic wipe and remote device wipe.
    /// Clears ALL sensitive data from all storage locations.
    func wipeAll() {
        // 1. Keychain — delete ALL items (device keys, PIN data, biometric, wake keys)
        keychainService.deleteAll()

        // 2. Rust crypto state — zeroize hub keys then lock (zeroize device secrets)
        cryptoService.clearHubKeys()
        cryptoService.lock()

        // 3. Wake key service — remove registered wake keypair
        wakeKeyService.cleanup()

        // 4. Offline queue — stop monitoring and delete queued operations
        offlineQueue.stopMonitoring()
        offlineQueue.clear()

        // 5. Crash logs — delete all crash report files
        crashReportingService.clearCrashLogs()

        // 6. URL cache — delete the cached responses, then leave behind a cache that
        // cannot store another one.
        //
        // Replacing `URLCache.shared` with a fresh instance deletes nothing: an
        // instance built with `diskPath: nil` inherits the *same* default on-disk
        // store, so every cached response survives the swap and is served again the
        // moment that store is consulted. It only looked like a clear because
        // `storeCachedResponse(_:for:)` is asynchronous — on an idle device the write
        // had not reached the store yet, so the next lookup missed for the wrong
        // reason (#1658).
        //
        // So: delete through the instance that owns the store, then install a cache
        // that is incapable of storing a write which was already in flight when the
        // wipe ran. That ordering is what removes the race, rather than narrowing it.
        URLCache.shared.removeAllCachedResponses()
        ResponseCachePolicy.installNonCachingSharedCache()

        // 7. HTTP cookies — remove all cookies
        if let cookies = HTTPCookieStorage.shared.cookies {
            cookies.forEach { HTTPCookieStorage.shared.deleteCookie($0) }
        }

        // 8. Temp directory — remove all temporary files
        clearDirectory(FileManager.default.temporaryDirectory)

        // 9. Caches directory — remove all cached data
        if let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
            clearDirectory(cachesDir)
        }

        // 10. Application Support (offline queue file, crash logs already cleared above, other app data)
        if let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            clearDirectory(appSupport)
        }

        // 11. Documents directory — exhaustive wipe covers any future file attachments or exports
        if let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            clearDirectory(documents)
        }

        // 12. WebSocket — disconnect from relay
        webSocketService.disconnect()

        // 13. UserDefaults — remove all app preferences
        if let bundleId = Bundle.main.bundleIdentifier {
            UserDefaults.standard.removePersistentDomain(forName: bundleId)
        }
    }

    /// Logout cleanup — less aggressive, preserves device keys for re-login.
    /// Does NOT clear: keychain (device keys), crash logs, URL cache, cookies, temp/caches dirs.
    func logout() {
        // Clear hub-scoped crypto state (hub keys, server event keys)
        cryptoService.clearHubKeys()
        cryptoService.lock()

        // Clean up wake key registration
        wakeKeyService.cleanup()

        // Stop and clear offline queue
        offlineQueue.stopMonitoring()
        offlineQueue.clear()

        // Disconnect WebSocket
        webSocketService.disconnect()
    }

    // MARK: - Private

    private func clearDirectory(_ url: URL) {
        let fm = FileManager.default
        guard let contents = try? fm.contentsOfDirectory(at: url, includingPropertiesForKeys: nil) else { return }
        for item in contents {
            try? fm.removeItem(at: item)
        }
    }
}
