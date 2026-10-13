import Foundation

/// Process-wide policy for HTTP response caching.
///
/// The app must never persist HTTP response bodies. Hub API responses carry E2EE
/// envelopes, hub rosters, member names and call history; a copy of any of those in
/// `URLCache`'s on-disk store is a copy outside every control the app otherwise puts
/// on it, and it outlives both logout and — before #1658 — a full device wipe.
///
/// Disabling the capability is also what makes `WipeService.wipeAll()` correct rather
/// than lucky. `URLCache.storeCachedResponse(_:for:)` is asynchronous, so a wipe that
/// deletes whatever is in the store at that instant races any write already queued
/// behind it. A cache that cannot store a response has no such race: a late write is
/// refused rather than landing after the wipe.
enum ResponseCachePolicy {

    /// Install a `URLCache.shared` that cannot store a response.
    ///
    /// `URLSessionConfiguration.default.urlCache` **is** `URLCache.shared` by identity,
    /// so this covers `URLSession.shared` and every default-configured session created
    /// afterwards. Call it before constructing anything that performs requests.
    static func installNonCachingSharedCache() {
        URLCache.shared = URLCache(memoryCapacity: 0, diskCapacity: 0, directory: nil)
    }

    /// Stop a session configuration reading or writing any response cache.
    ///
    /// Both halves are load-bearing: `urlCache = nil` removes the writer, and
    /// `.reloadIgnoringLocalCacheData` stops the session serving a response that some
    /// other holder of the default on-disk store wrote.
    static func harden(_ configuration: URLSessionConfiguration) {
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    }
}
