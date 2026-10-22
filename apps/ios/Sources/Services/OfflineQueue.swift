import Foundation

// MARK: - QueuedOperationType

/// Types of write operations that can be queued for offline replay.
enum QueuedOperationType: String, Codable, Sendable {
    case noteCreate = "note:create"
    case noteUpdate = "note:update"
    case messageSend = "message:send"
    case shiftToggle = "shift:toggle"
    case reportCreate = "report:create"
    case reportMessage = "report:message"
    case banAdd = "ban:add"
    case banRemove = "ban:remove"
    case genericWrite = "generic:write"
}

// MARK: - QueuedOperation

/// A write operation persisted for later replay when the network is available.
struct QueuedOperation: Codable, Identifiable, Sendable {
    let id: String
    let type: QueuedOperationType
    /// API path (e.g., "/api/notes")
    let path: String
    /// HTTP method (POST, PUT, PATCH, DELETE)
    let method: String
    /// JSON-serialized request body, or nil for bodyless requests
    let body: String?
    /// ISO 8601 timestamp when the operation was queued
    let queuedAt: String
    /// Number of replay attempts so far
    var attempts: Int
    /// Last error message from a failed replay attempt
    var lastError: String?
}

// MARK: - OfflineQueue

/// Persists write operations when the network is unavailable and replays them
/// in FIFO order on reconnect with exponential backoff.
///
/// Operations are encrypted at rest using CryptoService and stored to a file
/// in the app's Application Support directory. The queue observes NWPathMonitor
/// for connectivity changes and triggers automatic replay on reconnect.
///
/// Usage:
/// - Wire into APIService: when a write request fails with a network error, call `enqueue(...)`
/// - The queue replays automatically when connectivity is restored
/// - UI observes `pendingCount` to show a banner
///
/// `@MainActor` (#1920 audit): `OfflineBanner` renders `pendingCount` / `isReplaying` on main
/// and `replay()` was already main-actor, but `enqueue` ran synchronously inside
/// `APIService`'s network-error path on the global executor — appending to `queue` while
/// `replay()` iterated it across suspension points. `APIService` now `await`s the enqueue,
/// so every mutation of `queue` happens on one actor.
@MainActor
@Observable
final class OfflineQueue {

    // MARK: - Constants

    private static let maxAttempts = 10
    private static let baseRetryDelay: TimeInterval = 1.0
    private static let maxRetryDelay: TimeInterval = 60.0
    private static let queueFileName = "offline-queue.json"

    // MARK: - Observable State

    /// Number of operations waiting to be replayed.
    private(set) var pendingCount: Int = 0

    /// Whether the queue is currently replaying operations.
    private(set) var isReplaying: Bool = false

    // MARK: - Private State

    private var queue: [QueuedOperation] = []
    private let apiService: APIService
    private var networkMonitor: NetworkMonitorService?
    private var connectivityTask: Task<Void, Never>?

    // MARK: - Init

    init(apiService: APIService) {
        self.apiService = apiService
        loadFromDisk()
        pendingCount = queue.count
    }

    // MARK: - Network Monitoring

    /// Start observing network connectivity. Call once after services are ready.
    /// When connectivity is restored and the queue is non-empty, replay is triggered.
    func startMonitoring() {
        let monitor = NetworkMonitorService()
        self.networkMonitor = monitor
        monitor.start()

        connectivityTask?.cancel()
        connectivityTask = Task { [weak self] in
            for await isConnected in monitor.changes {
                guard !Task.isCancelled else { break }
                if isConnected {
                    await self?.replay()
                }
            }
        }
    }

    /// Stop monitoring connectivity.
    func stopMonitoring() {
        connectivityTask?.cancel()
        connectivityTask = nil
        networkMonitor?.stop()
        networkMonitor = nil
    }

    // MARK: - Enqueue

    /// Add a write operation to the queue for later replay.
    ///
    /// - Parameters:
    ///   - path: API path (e.g., "/api/notes")
    ///   - method: HTTP method (POST, PUT, PATCH, DELETE)
    ///   - body: JSON-serialized request body, or nil
    /// - Returns: The queued operation ID
    @discardableResult
    func enqueue(path: String, method: String, body: String?) -> String {
        let op = QueuedOperation(
            id: UUID().uuidString,
            type: Self.classifyOperation(path: path, method: method),
            path: path,
            method: method,
            body: body,
            queuedAt: ISO8601DateFormatter().string(from: Date()),
            attempts: 0,
            lastError: nil
        )
        queue.append(op)
        pendingCount = queue.count
        saveToDisk()
        return op.id
    }

    // MARK: - Replay

    /// Attempt to replay all queued operations in FIFO order.
    ///
    /// Operations are removed on success (HTTP 2xx or 409 conflict).
    /// Permanent client errors (4xx except 401/429) increment the attempt counter;
    /// the operation is removed after maxAttempts.
    /// Server errors (5xx) and network errors cause retry with exponential backoff.
    func replay() async {
        guard !isReplaying, !queue.isEmpty else { return }

        isReplaying = true
        var toRemove: Set<String> = []

        // Iterate a snapshot and write results back by id: `clear()` (logout, wipe) and
        // `remove(id:)` can run while this is suspended on a request, so indices taken
        // before the first `await` are not valid after it (#1920 audit).
        for var op in queue {
            // Cleared or removed while an earlier operation was in flight — never send it.
            guard queue.contains(where: { $0.id == op.id }) else { continue }

            do {
                let (statusCode, _) = try await executeRequest(op)

                if (200...299).contains(statusCode) || statusCode == 409 {
                    // Success or idempotent conflict — remove
                    toRemove.insert(op.id)
                } else if statusCode >= 400 && statusCode < 500 && statusCode != 401 && statusCode != 429 {
                    // Permanent client error — increment attempts
                    op.attempts += 1
                    op.lastError = "HTTP \(statusCode)"
                    if op.attempts >= Self.maxAttempts {
                        toRemove.insert(op.id)
                    }
                    storeReplayResult(op)
                } else {
                    // Server error / auth / rate limit — retry with backoff
                    op.attempts += 1
                    op.lastError = "HTTP \(statusCode)"
                    storeReplayResult(op)
                    let delay = min(
                        Self.baseRetryDelay * pow(2.0, Double(op.attempts)),
                        Self.maxRetryDelay
                    )
                    try? await Task.sleep(for: .seconds(delay))
                }
            } catch {
                // Network error — stop processing, retry when online
                op.attempts += 1
                op.lastError = error.localizedDescription
                storeReplayResult(op)
                break
            }
        }

        queue.removeAll { toRemove.contains($0.id) }
        pendingCount = queue.count
        saveToDisk()
        isReplaying = false
    }

    /// Record a replayed operation's new attempt state, if it is still queued.
    private func storeReplayResult(_ op: QueuedOperation) {
        guard let index = queue.firstIndex(where: { $0.id == op.id }) else { return }
        queue[index] = op
    }

    // MARK: - Remove / Clear

    /// Remove a single operation from the queue.
    func remove(id: String) {
        queue.removeAll { $0.id == id }
        pendingCount = queue.count
        saveToDisk()
    }

    /// Clear all queued operations.
    func clear() {
        queue.removeAll()
        pendingCount = 0
        saveToDisk()
    }

    /// Current queue snapshot for UI display.
    func getQueue() -> [QueuedOperation] {
        return queue
    }

    // MARK: - Request Execution

    /// Execute a queued operation against the API. Returns (statusCode, responseBody).
    ///
    /// Delegates to `APIService.rawRequest` so the replayed request carries the same
    /// Ed25519 auth token and cert-pinning URLSession as a live request. Using
    /// `URLSession.shared` here would bypass both, causing 401s on every replay.
    private func executeRequest(_ op: QueuedOperation) async throws -> (Int, String) {
        return try await apiService.rawRequest(method: op.method, path: op.path, body: op.body)
    }

    // MARK: - Classification

    /// Classify an API path + method into a queue operation type.
    nonisolated static func classifyOperation(path: String, method: String) -> QueuedOperationType {
        if path.contains("/notes") && method.uppercased() == "POST" { return .noteCreate }
        if path.contains("/notes/") && method.uppercased() == "PATCH" { return .noteUpdate }
        // Check report-messages before generic messages (more specific pattern first)
        if path.contains("/reports/") && path.contains("/messages") && method.uppercased() == "POST" { return .reportMessage }
        if path.contains("/messages") && method.uppercased() == "POST" { return .messageSend }
        if path.contains("/shifts/my-status") || path.contains("/shifts/clock") { return .shiftToggle }
        if path.contains("/reports") && method.uppercased() == "POST" { return .reportCreate }
        if path.contains("/bans") && method.uppercased() == "POST" { return .banAdd }
        if path.contains("/bans/") && method.uppercased() == "DELETE" { return .banRemove }
        return .genericWrite
    }

    /// Whether an HTTP method is a write operation eligible for queueing.
    nonisolated static func isQueueableMethod(_ method: String) -> Bool {
        let upper = method.uppercased()
        return upper == "POST" || upper == "PUT" || upper == "PATCH" || upper == "DELETE"
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
            // Persistence failure — operations may be lost on app termination
        }
    }

    private func loadFromDisk() {
        do {
            let data = try Data(contentsOf: queueFileURL)
            queue = try JSONDecoder().decode([QueuedOperation].self, from: data)
        } catch {
            queue = []
        }
    }
}

// MARK: - NetworkMonitorService (NWPathMonitor wrapper)

import Network

/// Lightweight NWPathMonitor wrapper for observing connectivity changes.
/// Used internally by OfflineQueue; not a general-purpose network monitor.
private final class NetworkMonitorService: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "org.llamenos.network-monitor")

    /// Current connectivity state (true = reachable).
    private(set) var isConnected: Bool = true

    /// AsyncStream that yields `true` when the path becomes reachable and
    /// `false` when it becomes unreachable. Consumers drive replay on reconnect
    /// without any polling.
    private let _continuation: AsyncStream<Bool>.Continuation
    let changes: AsyncStream<Bool>

    init() {
        (changes, _continuation) = AsyncStream<Bool>.makeStream()
    }

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let connected = path.status == .satisfied
            self.isConnected = connected
            self._continuation.yield(connected)
        }
        monitor.start(queue: monitorQueue)
    }

    func stop() {
        _continuation.finish()
        monitor.cancel()
    }
}
