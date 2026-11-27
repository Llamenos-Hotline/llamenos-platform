import Foundation

/// A record's triage state — its status and severity — lives ONLY in its sealed
/// summary (#2779, #3114). The server holds neither, so everything that shows,
/// filters or sorts by it happens here, after the summary is opened.
///
/// The summary carries the status and severity VALUES (the stable keys of the
/// entity type's `statuses` / `severities`), never their labels: a label is
/// editable text, and a filter that matched on it would lose every record the day
/// an admin renamed a status.
///
/// When a status filter is active the server still filters on what it can see (hub,
/// entity type, parent) and pages that candidate set; the client opens each summary
/// and keeps the matches, up to `scanLimit`. The bound is never silent: a result that
/// stopped at it says so, and an empty one says so too instead of reading as "none".
/// This is the M1 shape; filtered server pagination returns with v2's per-hub index
/// tokens (D7/E5), which replace the scan.
enum CaseTriage {
    /// How many of the newest records a status filter looks through. The same number
    /// on every client (desktop: `CLIENT_FILTER_SCAN_LIMIT`).
    static let scanLimit = 2000

    /// Records fetched per round trip while scanning (the server's page cap).
    static let batchSize = 100

    /// The interaction type that marks a write as a status change. The server cannot see
    /// the status, so it learns that one happened from this and nothing else (registered
    /// as known debt, #3118).
    static let statusChangeType = "status_change"

    /// A page of `items`, the way the server pages an unfiltered list. `page` is 1-based.
    static func page<T>(of items: [T], page: Int, pageSize: Int) -> [T] {
        let start = (page - 1) * pageSize
        guard start >= 0, start < items.count else { return [] }
        return Array(items[start..<min(start + pageSize, items.count)])
    }

    /// The transition a status change seals with its timeline entry. `text` is empty: the
    /// entry names the two statuses and nothing else.
    static func statusChangePlaintext(previous: String?, next: String) throws -> String {
        var change: [String: Any] = ["text": "", "newStatus": next]
        if let previous { change["previousStatus"] = previous }
        let data = try JSONSerialization.data(withJSONObject: change)
        return String(decoding: data, as: UTF8.self)
    }
}

/// The part of a transition a timeline entry shows.
struct StatusChange: Equatable, Sendable {
    let previous: String?
    let next: String?

    /// Parse a sealed status-change entry's plaintext, `{text, previousStatus, newStatus}`.
    init?(plaintext: String) {
        guard let data = plaintext.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        previous = json["previousStatus"] as? String
        next = json["newStatus"] as? String
        if previous == nil && next == nil { return nil }
    }
}
