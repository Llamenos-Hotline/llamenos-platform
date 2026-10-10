import Foundation

// MARK: - Shift Extensions
// The `Shift` struct is defined in the generated Types.swift (protocol codegen).
// We extend it here with Identifiable conformance and UI computed properties.

extension Shift: Identifiable {
    /// Days as Int array (generated type uses [Double] from JSON).
    var daysAsInt: [Int] {
        days.map { Int($0) }
    }

    /// Parse the start time string into a Date using ISO 8601 or HH:mm format.
    var startDate: Date? {
        Self.parseTime(startTime)
    }

    /// Parse the end time string into a Date using ISO 8601 or HH:mm format.
    var endDate: Date? {
        Self.parseTime(endTime)
    }

    /// Human-readable time range (e.g., "09:00 - 17:00").
    var timeRangeDisplay: String {
        let start = formatTimeForDisplay(startTime)
        let end = formatTimeForDisplay(endTime)
        return "\(start) - \(end)"
    }

    /// Human-readable day names for this shift's days.
    var dayNames: [String] {
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        let weekdaySymbols = formatter.shortWeekdaySymbols ?? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        return daysAsInt.compactMap { day in
            guard day >= 0, day < weekdaySymbols.count else { return nil }
            return weekdaySymbols[day]
        }
    }

    /// Number of users assigned to this shift.
    var volunteerCount: Int {
        userPubkeys.count
    }

    /// Whether the current day of the week is one of this shift's days.
    var isActiveToday: Bool {
        let weekday = Calendar.current.component(.weekday, from: Date()) - 1  // Sunday = 0
        return daysAsInt.contains(weekday)
    }

    // MARK: - Private Helpers

    private static func parseTime(_ timeString: String) -> Date? {
        // Try ISO 8601 first
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = isoFormatter.date(from: timeString) {
            return date
        }
        // Fallback: try without fractional seconds
        isoFormatter.formatOptions = [.withInternetDateTime]
        if let date = isoFormatter.date(from: timeString) {
            return date
        }
        // Fallback: HH:mm format (shift schedules may just have times)
        let timeFormatter = DateFormatter()
        timeFormatter.dateFormat = "HH:mm"
        if let date = timeFormatter.date(from: timeString) {
            return date
        }
        return nil
    }

    private func formatTimeForDisplay(_ timeString: String) -> String {
        if let date = Self.parseTime(timeString) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        // If parsing fails, return the raw string
        return timeString
    }
}

// MARK: - ShiftsListResponse
// Generated `ShiftListResponse` exists with the same shape. Use a typealias.

typealias ShiftsListResponse = ShiftListResponse

// MARK: - ShiftDay

/// Helper for grouping shifts by day in the calendar view.
struct ShiftDay: Identifiable, Sendable {
    let id: Int          // day index 0-6
    let name: String     // full weekday name
    let shortName: String
    let shifts: [Shift]
    let isToday: Bool
}
