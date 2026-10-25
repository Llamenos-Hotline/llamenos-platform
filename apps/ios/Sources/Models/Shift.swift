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

// MARK: - Generated shift-admin types: Identifiable
// These structs come from protocol codegen (Types.swift) and are plain
// Codable+Sendable. Identifiable conformance is added here so SwiftUI lists
// can diff them; nothing about the wire shape changes.

extension RingGroup: Identifiable {}
extension Override: Identifiable {}
extension Block: Identifiable {}
extension Request: Identifiable {}

/// Members of a ring group are keyed by their user pubkey (unique within a group).
extension RingGroupDetailResponseMember: Identifiable {
    var id: String { pubkey }
}

// MARK: - ShiftDay

/// Helper for grouping shifts by day in the calendar view.
struct ShiftDay: Identifiable, Sendable {
    let id: Int          // day index 0-6
    let name: String     // full weekday name
    let shortName: String
    let shifts: [Shift]
    let isToday: Bool
}

// MARK: - ShiftReadiness

/// What a volunteer can truthfully be told about receiving calls on one hub.
///
/// The server rings `scheduled now ∩ clocked in` (`apps/worker/services/ringing.ts`) and
/// then drops anyone on break. Each is a separate fact, so "On Shift" is only honest when
/// all of them hold. Mirrors `src/client/lib/call-readiness.ts` — the desktop dashboard
/// used to say "Ready for calls" for a volunteer who was scheduled but never clocked in
/// while the server rang nobody (#2108); iOS had the same defect in both directions (#2204).
enum ShiftReadiness: Equatable, Sendable {
    /// Scheduled, clocked in and not on break — the server will ring this user.
    case ready
    /// On break: excluded from ringing whatever else is true.
    case onBreak
    /// Scheduled now, but has not clocked in — the server will NOT ring this user.
    case notClockedIn
    /// Clocked in, but no shift covers this moment — the server will NOT ring this user.
    case unscheduled
    /// Neither scheduled nor clocked in.
    case offShift

    init(status: MyStatusResponse, onBreak: Bool) {
        if onBreak {
            self = .onBreak
        } else if status.onShift && status.clockedIn {
            self = .ready
        } else if status.onShift {
            self = .notClockedIn
        } else if status.clockedIn {
            self = .unscheduled
        } else {
            self = .offShift
        }
    }

    /// Whether the server will ring this volunteer.
    var isRingTarget: Bool { self == .ready }

    /// The most informative state across several hubs. A volunteer who is a ring target on
    /// any member hub is rung, so `.ready` wins; below that the order is how close the
    /// volunteer is to being rung.
    static func best(of states: [ShiftReadiness]) -> ShiftReadiness? {
        let order: [ShiftReadiness] = [.ready, .onBreak, .notClockedIn, .unscheduled, .offShift]
        return order.first { states.contains($0) }
    }
}

extension ShiftReadiness {
    /// Headline shown on the Dashboard and the Shifts screen.
    var title: String {
        switch self {
        case .ready: NSLocalizedString("dashboard_on_shift", comment: "On Shift")
        case .onBreak: NSLocalizedString("dashboard_on_break", comment: "On Break")
        case .notClockedIn: NSLocalizedString("dashboard_not_clocked_in", comment: "Not clocked in")
        case .unscheduled, .offShift: NSLocalizedString("dashboard_off_shift", comment: "Off Shift")
        }
    }

    /// Why the volunteer is not being rung, for the states where the headline alone would
    /// leave them guessing. Nil when ringing, and when there is nothing to add.
    var explanation: String? {
        switch self {
        case .notClockedIn: NSLocalizedString("dashboard_clock_in_to_receive_calls", comment: "You're scheduled now. Clock in to receive calls.")
        case .unscheduled: NSLocalizedString("dashboard_clocked_in_not_scheduled", comment: "You're clocked in, but no shift covers you right now, so calls won't ring you.")
        case .onBreak: NSLocalizedString("dashboard_break_description", comment: "You won't receive calls while on break")
        case .ready, .offShift: nil
        }
    }
}
