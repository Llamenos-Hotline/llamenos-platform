import Foundation
import Network

// MARK: - SecurityEventRecord

/// A single client-observed security event, persisted to disk until it is
/// successfully uploaded to the server (possibly across app restarts).
///
/// Deliberately narrow: this is the ONLY shape that ever touches disk or the
/// network for security events. It carries no PII and no key material — see
/// `SecurityEventUploadItem` for the (even narrower) wire format.
struct SecurityEventRecord: Codable, Identifiable, Sendable, Equatable {
    let id: String
    /// e.g. "cert_pin_mismatch". Distinct from the server-side `SecurityEvent`
    /// protocol type (packages/protocol/schemas/devices.ts) to avoid name collision.
    let eventType: String
    /// ISO 8601 timestamp of when the event was observed on-device.
    let occurredAt: String
    /// "<CFBundleShortVersionString> (<CFBundleVersion>)"
    let appVersion: String
    /// "iOS <ProcessInfo.operatingSystemVersionString>"
    let osVersion: String
    /// Base64 SPKI SHA-256 hashes involved in the event — both the pins this
    /// client expected and the hash(es) actually observed on the wire. No
    /// hostname, no IP, no user or device identifier.
    let pinIdentifiers: [String]
    /// Upload attempts so far. Used to compute backoff; also bounds how long
    /// a malformed/unsendable record is retried before being dropped.
    var attempts: Int
    var lastError: String?
    /// ISO 8601 timestamp before which this record should not be retried.
    /// Set to "now" on creation so the first flush attempt is immediate.
    var nextAttemptAt: String
}

// MARK: - SecurityEventService

/// Service for reporting client-observed security events (currently: certificate
/// pin mismatches) to the server.
///
/// Events are persisted to disk immediately on `report(_:)` — synchronously, before
/// any network attempt — so they survive an app restart or crash. They are then
/// uploaded to the server in batches, in both debug AND release builds, with
/// exponential backoff on failure. Upload failures never throw, block, or crash
/// the caller; a failed batch just stays queued for the next attempt.
///
/// ## Why this can't be blocked by the pinning failure it reports
///
/// `report(.certPinMismatch)` is called from `CertificatePinningDelegate` at the
/// exact moment a TLS handshake failed pin validation. If event upload reused the
/// app's normal pinned `URLSession`, a persistent pin mismatch (e.g. the intended
/// threat model: a MITM presenting a certificate we correctly refuse) would also
/// break every future upload attempt — the one report that most needs to reach the
/// server would be the one report that can never leave the device.
///
/// To avoid this, `uploadSession` is a **separate** `URLSession` with no custom
/// `URLSessionDelegate` at all — it falls back to the OS's standard TLS trust
/// evaluation (a valid, publicly-trusted certificate chain), not this deployment's
/// pinned SPKI hashes. This is a narrow, deliberate exception to certificate
/// pinning, scoped ONLY to this one reporting channel:
/// - It still requires a certificate the device's trust store accepts, so a
///   passive network attacker without a trusted CA cannot intercept the report.
/// - It reports exactly the failure that would otherwise go unreported: a pin
///   mismatch caused by a legitimate (but unexpected) CA rotation, OR by an
///   active MITM — either way, an admin needs to see it to tell the two apart.
/// - It never carries the credentials or content that pinning exists to protect
///   (auth tokens, note/message plaintext); it carries only the fields on
///   `SecurityEventUploadItem`.
@Observable
final class SecurityEventService: @unchecked Sendable {
    static let shared = SecurityEventService()

    /// Client-side security event kinds. Distinct from the server-side `SecurityEvent`
    /// protocol type (packages/protocol/schemas/devices.ts) to avoid name collision.
    enum Report {
        /// `activePins`: the SPKI hashes this client currently trusts.
        /// `observedPins`: the SPKI hash(es) actually presented by the server.
        case certPinMismatch(activePins: [String], observedPins: [String])
    }

    // MARK: - Constants

    private static let maxAttempts = 20
    private static let baseRetryDelay: TimeInterval = 2.0
    private static let maxRetryDelay: TimeInterval = 120.0
    private static let batchSize = 20
    /// Bounds disk growth if the server is unreachable (or unimplemented) for a
    /// very long time. Oldest events are dropped first — losing the oldest
    /// duplicate of a still-ongoing mismatch matters less than losing all of them.
    private static let maxQueueSize = 500
    private static let queueFileName = "security-events-queue.json"

    // MARK: - Observable State

    /// Number of events waiting to be uploaded.
    private(set) var pendingCount: Int = 0

    /// Whether a batch upload is currently in flight.
    private(set) var isUploading: Bool = false

    // MARK: - Private State

    private var queue: [SecurityEventRecord] = []
    private var baseURL: URL?
    private let uploadSession: URLSession
    private let queueLock = NSLock()
    private var pathMonitor: NWPathMonitor?
    private var connectivityTask: Task<Void, Never>?

    private static let isoFormatter = ISO8601DateFormatter()

    // MARK: - Init

    /// - Parameter uploadSession: Injectable for tests. Production callers should
    ///   use `.shared`, which uses `makeDefaultUploadSession()` — a session with NO
    ///   certificate-pinning delegate. See the type doc comment for why.
    init(uploadSession: URLSession = SecurityEventService.makeDefaultUploadSession()) {
        self.uploadSession = uploadSession
        loadFromDisk()
        pendingCount = queue.count
    }

    private static func makeDefaultUploadSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        // Deliberately no delegate: use the OS's default TLS trust evaluation
        // rather than CertificatePinningDelegate. See type doc comment.
        return URLSession(configuration: config)
    }

    // MARK: - Configuration

    /// Set (or clear) the server base URL used for uploads. Safe to call before
    /// any hub is configured — events queue durably until a URL is available.
    ///
    /// Does NOT itself trigger a flush (mirrors `OfflineQueue`'s separation of
    /// "configure" from "replay/flush"): callers that want an immediate delivery
    /// attempt right after configuring a URL should follow up with
    /// `Task { await SecurityEventService.shared.flush() }`, same as `AppState`
    /// does for `OfflineQueue.replay()`. This keeps flush triggers explicit and
    /// out of a hot, possibly background-thread, configuration path.
    func configure(baseURL: URL?) {
        queueLock.lock()
        self.baseURL = baseURL
        queueLock.unlock()
    }

    // MARK: - Connectivity Monitoring

    /// Start observing network connectivity so a queued event is retried as soon
    /// as the network comes back — not just on the next `report()` call.
    func startMonitoring() {
        stopMonitoring()

        let monitor = NWPathMonitor()
        let monitorQueue = DispatchQueue(label: "org.llamenos.security-events.network-monitor")
        let (stream, continuation) = AsyncStream<Bool>.makeStream()

        monitor.pathUpdateHandler = { path in
            continuation.yield(path.status == .satisfied)
        }
        monitor.start(queue: monitorQueue)
        pathMonitor = monitor

        connectivityTask = Task { [weak self] in
            for await isConnected in stream {
                guard !Task.isCancelled else { break }
                if isConnected {
                    await self?.flush()
                }
            }
        }
    }

    func stopMonitoring() {
        connectivityTask?.cancel()
        connectivityTask = nil
        pathMonitor?.cancel()
        pathMonitor = nil
    }

    // MARK: - Report

    /// Report a security event. The event is persisted to disk synchronously
    /// (before this call returns) so it survives an immediate app kill. Delivery
    /// happens on the next flush trigger (connectivity change, a base URL becoming
    /// available, or an app-lifecycle call to `flush()`) — never inline here, so
    /// this call never throws, never blocks, and never touches the network.
    func report(_ event: Report) {
        switch event {
        case .certPinMismatch(let activePins, let observedPins):
            #if DEBUG
            print("[SecurityEvent] cert_pin_mismatch active=\(activePins) observed=\(observedPins)")
            #endif

            var identifiers = activePins
            for pin in observedPins where !identifiers.contains(pin) {
                identifiers.append(pin)
            }

            let now = Date()
            let record = SecurityEventRecord(
                id: UUID().uuidString,
                eventType: "cert_pin_mismatch",
                occurredAt: Self.isoFormatter.string(from: now),
                appVersion: Self.appVersion(),
                osVersion: Self.osVersion(),
                pinIdentifiers: identifiers,
                attempts: 0,
                lastError: nil,
                nextAttemptAt: Self.isoFormatter.string(from: now)
            )
            enqueue(record)
        }

        // Deliberately no auto-flush here (mirrors OfflineQueue.enqueue): a batch
        // upload is a real network operation and firing it unconditionally from
        // every call site of `report()` — including delegate callbacks that may
        // run on arbitrary background queues — would race against whichever flush
        // trigger runs next (connectivity change, `configure(baseURL:)`, or an
        // explicit app-lifecycle call). Those triggers cover the delivery cases
        // that matter: already-online-at-startup, hub URL just became known, and
        // connectivity just came back after being offline.
    }

    private func enqueue(_ record: SecurityEventRecord) {
        queueLock.lock()
        queue.append(record)
        if queue.count > Self.maxQueueSize {
            queue.removeFirst(queue.count - Self.maxQueueSize)
        }
        pendingCount = queue.count
        saveToDisk()
        queueLock.unlock()
    }

    // MARK: - Flush / Upload

    /// Attempt to upload all due events, in FIFO batches of `batchSize`. Stops at
    /// the first batch that fails (network error, or non-2xx that isn't a
    /// permanent client error) so remaining events keep their FIFO order for the
    /// next attempt. Returns the number of events successfully uploaded.
    @discardableResult
    func flush() async -> Int {
        queueLock.lock()
        let currentBaseURL = baseURL
        queueLock.unlock()
        guard let baseURL = currentBaseURL else { return 0 }

        queueLock.lock()
        let alreadyUploading = isUploading
        if !alreadyUploading { isUploading = true }
        queueLock.unlock()
        if alreadyUploading { return 0 }

        defer {
            queueLock.lock()
            isUploading = false
            queueLock.unlock()
        }

        var uploadedTotal = 0

        while true {
            let now = Date()
            let batch: [SecurityEventRecord] = {
                queueLock.lock()
                defer { queueLock.unlock() }
                return Array(queue.filter { isDue($0, at: now) }.prefix(Self.batchSize))
            }()

            if batch.isEmpty { break }

            let outcome = await uploadBatch(batch, baseURL: baseURL)
            let ids = Set(batch.map(\.id))

            switch outcome {
            case .success:
                removeAll(ids: ids)
                uploadedTotal += batch.count
            case .retryable(let message):
                markFailed(ids: ids, error: message)
                return uploadedTotal
            case .permanent(let message):
                markPermanentlyFailed(ids: ids, error: message)
                // Other due batches may still be uploadable — keep going.
            }
        }

        return uploadedTotal
    }

    private enum UploadOutcome {
        case success
        /// Network error, 5xx, 401, or 429 — retried indefinitely with backoff.
        case retryable(String)
        /// 400/422 — the payload itself will never be accepted; drop after
        /// `maxAttempts` rather than retrying forever.
        case permanent(String)
    }

    private func uploadBatch(_ batch: [SecurityEventRecord], baseURL: URL) async -> UploadOutcome {
        let url = baseURL.appendingPathComponent("/api/security-events")
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let payload = SecurityEventBatchPayload(events: batch.map(SecurityEventUploadItem.init))
        do {
            // #1633 audit: this strategy is CORRECT here and must stay. Unlike every
            // other endpoint, `POST /api/security-events` declares snake_case keys —
            // `clientSecurityEventItemSchema` in apps/worker/schemas/client-security-events.ts
            // is a `z.strictObject` of `event_type`, `occurred_at`, `app_version`,
            // `os_version`, `pin_identifiers`, because the submission is unauthenticated
            // and deliberately narrow. Being `strictObject`, it also *rejects* an unknown
            // key rather than ignoring it, so a mismatch here fails loudly — which is why
            // it is the only body in the app that is safe to key-convert.
            //
            // This is also why the conversion lives at the call site rather than on a
            // shared encoder, and why this service builds its own URLRequest instead of
            // going through APIService.
            let encoder = JSONEncoder()
            encoder.keyEncodingStrategy = .convertToSnakeCase
            request.httpBody = try encoder.encode(payload)
        } catch {
            return .permanent("encode failure: \(error.localizedDescription)")
        }

        do {
            let (_, response) = try await uploadSession.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return .retryable("non-HTTP response")
            }
            if (200...299).contains(http.statusCode) {
                return .success
            }
            if http.statusCode == 400 || http.statusCode == 422 {
                return .permanent("HTTP \(http.statusCode)")
            }
            return .retryable("HTTP \(http.statusCode)")
        } catch {
            return .retryable(error.localizedDescription)
        }
    }

    private func isDue(_ record: SecurityEventRecord, at date: Date) -> Bool {
        guard let next = Self.isoFormatter.date(from: record.nextAttemptAt) else { return true }
        return next <= date
    }

    private func removeAll(ids: Set<String>) {
        queueLock.lock()
        queue.removeAll { ids.contains($0.id) }
        pendingCount = queue.count
        saveToDisk()
        queueLock.unlock()
    }

    private func markFailed(ids: Set<String>, error: String) {
        queueLock.lock()
        for i in queue.indices where ids.contains(queue[i].id) {
            queue[i].attempts += 1
            queue[i].lastError = error
            let delay = Self.backoffDelay(forAttempt: queue[i].attempts)
            queue[i].nextAttemptAt = Self.isoFormatter.string(from: Date().addingTimeInterval(delay))
        }
        // Extremely persistent failures (e.g. an endpoint that will never exist)
        // are eventually dropped too, so the queue can't grow forever.
        queue.removeAll { ids.contains($0.id) && $0.attempts >= Self.maxAttempts }
        pendingCount = queue.count
        saveToDisk()
        queueLock.unlock()
    }

    private func markPermanentlyFailed(ids: Set<String>, error: String) {
        queueLock.lock()
        queue.removeAll { ids.contains($0.id) }
        pendingCount = queue.count
        saveToDisk()
        queueLock.unlock()
    }

    /// Exponential backoff, exposed for testing. Attempt 0/1 → ~2-4s, capped at 120s.
    static func backoffDelay(forAttempt attempt: Int) -> TimeInterval {
        min(baseRetryDelay * pow(2.0, Double(max(attempt, 0))), maxRetryDelay)
    }

    // MARK: - Test / Diagnostic Access

    /// Current queue snapshot. Exposed for tests; not for production UI use.
    func getQueue() -> [SecurityEventRecord] {
        queueLock.lock()
        defer { queueLock.unlock() }
        return queue
    }

    /// Remove all queued events and their on-disk state. Exposed for tests.
    func clear() {
        queueLock.lock()
        queue.removeAll()
        pendingCount = 0
        saveToDisk()
        queueLock.unlock()
    }

    // MARK: - Persistence

    private var queueFileURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("llamenos", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(Self.queueFileName)
    }

    private func saveToDisk() {
        do {
            let data = try JSONEncoder().encode(queue)
            try data.write(to: queueFileURL, options: [.atomic, .completeFileProtection])
        } catch {
            // Persistence failure — events may be lost on app termination. There is
            // no lower-priority fallback path; this mirrors OfflineQueue.
        }
    }

    private func loadFromDisk() {
        do {
            let data = try Data(contentsOf: queueFileURL)
            queue = try JSONDecoder().decode([SecurityEventRecord].self, from: data)
        } catch {
            queue = []
        }
    }

    // MARK: - Device info helpers

    private static func appVersion() -> String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
        return "\(version) (\(build))"
    }

    private static func osVersion() -> String {
        "iOS \(ProcessInfo.processInfo.operatingSystemVersionString)"
    }
}

// MARK: - Wire Format

/// The ONLY shape ever sent over the network for a security event. Deliberately
/// narrower than `SecurityEventRecord` — `attempts`, `lastError`, and
/// `nextAttemptAt` are local bookkeeping and must never leave the device.
private struct SecurityEventUploadItem: Encodable {
    let eventType: String
    let occurredAt: String
    let appVersion: String
    let osVersion: String
    let pinIdentifiers: [String]

    init(_ record: SecurityEventRecord) {
        eventType = record.eventType
        occurredAt = record.occurredAt
        appVersion = record.appVersion
        osVersion = record.osVersion
        pinIdentifiers = record.pinIdentifiers
    }
}

private struct SecurityEventBatchPayload: Encodable {
    let events: [SecurityEventUploadItem]
}
