import Foundation

enum DateFormatting {
    private static let isoFull: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoBasic: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parseISO(_ string: String) -> Date? {
        isoFull.date(from: string) ?? isoBasic.date(from: string)
    }

    private static let wireDate: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// YYYY-MM-DD for shift override/availability date fields. The server
    /// compares these strings lexicographically, and desktop derives them from
    /// `toISOString()` (UTC) — so the UTC calendar day is used regardless of
    /// the device's time zone.
    static func wireDateString(from date: Date) -> String {
        wireDate.string(from: date)
    }
}
