import Foundation
import UIKit

// MARK: - ShiftsViewModel

/// View model for the Shifts tab. Manages shift schedule display, clock in/out toggle,
/// and shift signup. Groups shifts by day for the weekly calendar view.
///
/// SIP integration: when the volunteer clocks in, `onShiftStarted` fetches a short-lived
/// SIP token from the hub and registers a Linphone account. On clock out, `onShiftEnded`
/// unregisters the account so the volunteer stops receiving VoIP calls.
@Observable
final class ShiftsViewModel {
    private let apiService: APIService
    private let hubContext: HubContext
    private let linphoneService: any LinphoneServiceProtocol
    private let shiftClockService: ShiftClockService

    // MARK: - Public State

    /// All shifts from the server.
    var shifts: [Shift] = []

    /// Shifts grouped by day of week for the calendar view.
    var shiftDays: [ShiftDay] = []

    /// Whether this device is clocked in to the active hub.
    ///
    /// Sourced from `ShiftClockService`, not `GET /shifts/my-status`: that endpoint's
    /// `onShift` means "a scheduled shift containing this volunteer is active right
    /// now", which is true whether or not the volunteer ever clocked in — exactly the
    /// conflation #1216 removed on Android.
    var isOnShift: Bool {
        guard let hubId = hubContext.activeHubId else { return false }
        return shiftClockService.isClockedIn(to: hubId)
    }

    /// When this device clocked in to the active hub, for the elapsed timer.
    var shiftStartedAt: Date? {
        guard let hubId = hubContext.activeHubId else { return nil }
        return shiftClockService.clockedInAt(for: hubId)
    }

    /// Shifts with a join/leave request awaiting admin review, submitted from this screen.
    private(set) var pendingRequestShiftIds: Set<String> = []

    /// My availability blocks (dates I cannot take calls), from `GET /shifts/availability/my`.
    var myAvailabilityBlocks: [Block] = []

    /// Whether the availability blocks are loading.
    var isLoadingAvailability: Bool = false

    /// Whether the "mark unavailable" sheet is shown.
    var showAvailabilitySheet: Bool = false

    /// Whether the initial load is in progress.
    var isLoading: Bool = false

    /// Whether a clock in/out operation is in progress.
    var isTogglingShift: Bool = false

    /// Error message from the last failed operation.
    var errorMessage: String?

    /// Success message after an action.
    var successMessage: String?

    /// Whether the clock out confirmation dialog is shown.
    var showClockOutConfirmation: Bool = false

    /// Elapsed time string for the active shift timer.
    var elapsedTimeDisplay: String {
        // Reading `tick` subscribes the view to the once-a-second timer invalidations.
        _ = tick
        guard let startedAt = shiftStartedAt else { return "--:--:--" }
        let elapsed = Date().timeIntervalSince(startedAt)
        let hours = Int(elapsed) / 3600
        let minutes = (Int(elapsed) % 3600) / 60
        let seconds = Int(elapsed) % 60
        return String(format: "%02d:%02d:%02d", hours, minutes, seconds)
    }

    // MARK: - Private State

    private var timerTask: Task<Void, Never>?

    /// Bumped once a second while clocked in so the elapsed-time display re-evaluates.
    private var tick: Int = 0

    // MARK: - Initialization

    init(
        apiService: APIService,
        hubContext: HubContext,
        linphoneService: any LinphoneServiceProtocol,
        shiftClockService: ShiftClockService
    ) {
        self.apiService = apiService
        self.hubContext = hubContext
        self.linphoneService = linphoneService
        self.shiftClockService = shiftClockService
    }

    // MARK: - SIP Account Lifecycle

    /// Why in-app audio is unavailable for this shift, when it is. Nil when the SIP
    /// account registered, and nil on a hub that never asked for one.
    ///
    /// Recorded rather than swallowed: `registerHubAccount` refuses an unencryptable
    /// media leg and an unverifiable TLS chain, and each refusal means this volunteer
    /// will not be rung in the app. Discarding it is how a volunteer ends up believing
    /// they are reachable. Not yet rendered — that needs a localized string in
    /// packages/i18n (follow-up); this makes it observable and testable now.
    var sipRegistrationError: String?

    /// Register a SIP account with Linphone for the given hub. Called after clock-in succeeds.
    func onShiftStarted(hubId: String, sipParams: SipTokenResponse) async {
        do {
            try linphoneService.registerHubAccount(hubId: hubId, sipParams: sipParams)
            sipRegistrationError = nil
        } catch {
            sipRegistrationError = error.localizedDescription
        }
    }

    /// Unregister the SIP account for the given hub. Called after clock-out succeeds.
    func onShiftEnded(hubId: String) {
        linphoneService.unregisterHubAccount(hubId: hubId)
    }

    // MARK: - Data Loading

    /// Load shifts and current status from the API.
    func loadShifts() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil

        await fetchShifts()
        syncTimer()

        isLoading = false
    }

    /// Refresh shifts (pull-to-refresh).
    func refresh() async {
        isLoading = false
        await loadShifts()
    }

    // MARK: - Clock In / Out

    /// Clock in to start a shift.
    func clockIn() async {
        guard let hubId = hubContext.activeHubId else {
            errorMessage = NSLocalizedString("error_no_hub_selected", comment: "No hub selected")
            return
        }

        isTogglingShift = true
        errorMessage = nil
        successMessage = nil

        do {
            try await shiftClockService.clockIn(hubId: hubId)
            startTimer()

            // Register a SIP account so the volunteer receives VoIP calls for this hub.
            //
            // `try?` is gone: it is what hid #1659 for the whole life of this code. The
            // token could not decode on any build, `getSipToken` threw on every call, and
            // the discarded error meant clock-in reported success with no SIP
            // registration and nothing anywhere recording why. The failure is now
            // observable state (`sipRegistrationError`) that the unit tests pin; putting
            // it on screen needs a localized string in packages/i18n and is follow-up —
            // but it can no longer be lost.
            do {
                await onShiftStarted(hubId: hubId, sipParams: try await apiService.getSipToken())
            } catch {
                sipRegistrationError = error.localizedDescription
            }

            let generator = UIImpactFeedbackGenerator(style: .medium)
            generator.impactOccurred()

            successMessage = NSLocalizedString("shifts_clocked_in", comment: "You are now on shift")
        } catch {
            errorMessage = error.localizedDescription
        }

        isTogglingShift = false
    }

    /// Clock out to end the current shift.
    func clockOut() async {
        guard let hubId = hubContext.activeHubId else {
            errorMessage = NSLocalizedString("error_no_hub_selected", comment: "No hub selected")
            return
        }

        isTogglingShift = true
        errorMessage = nil
        successMessage = nil

        do {
            try await shiftClockService.clockOut(hubId: hubId)
            stopTimer()

            // Unregister the SIP account so the volunteer stops receiving VoIP calls.
            onShiftEnded(hubId: hubId)

            let generator = UIImpactFeedbackGenerator(style: .light)
            generator.impactOccurred()

            successMessage = NSLocalizedString("shifts_clocked_out", comment: "You are now off shift")
        } catch {
            errorMessage = error.localizedDescription
        }

        isTogglingShift = false
    }

    /// Sign up for a shift by submitting a join request for admin review.
    ///
    /// There is no `POST /shifts/{id}/signup` on the server — volunteers never edit a
    /// shift's roster directly. The volunteer path is a join/leave request
    /// (`POST /hubs/{hubId}/shifts/requests`), which an admin approves or rejects.
    func signUp(for shift: Shift) async {
        guard let hubId = hubContext.activeHubId else {
            errorMessage = NSLocalizedString("error_no_hub_selected", comment: "No hub selected")
            return
        }

        errorMessage = nil
        successMessage = nil

        do {
            let body = CreateShiftJoinRequestBody(shiftID: shift.id, type: .join)
            let _: ShiftJoinRequestResponse = try await apiService.request(
                method: "POST",
                path: APIService.hubPath(hubId, "/api/shifts/requests"),
                body: body
            )

            pendingRequestShiftIds.insert(shift.id)

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = L10n.format("shifts_signed_up", comment: "Signed up for %@", shift.encryptedName.isEmpty ? shift.timeRangeDisplay : shift.encryptedName)
        } catch APIError.requestFailed(let statusCode, _) where statusCode == 409 {
            // A request for this shift is already awaiting review.
            pendingRequestShiftIds.insert(shift.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Availability Blocks

    /// Load my availability blocks for the active hub.
    func loadAvailabilityBlocks() async {
        isLoadingAvailability = true
        do {
            let response: AvailabilityBlockListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/shifts/availability/my")
            )
            myAvailabilityBlocks = response.blocks.sorted { $0.startDate < $1.startDate }
        } catch {
            if case APIError.noBaseURL = error {
                // Hub not configured — no blocks to show
            } else if errorMessage == nil {
                errorMessage = error.localizedDescription
            }
            myAvailabilityBlocks = []
        }
        isLoadingAvailability = false
    }

    /// Mark myself unavailable for a date range (inclusive), with an optional
    /// reason. The routing pipeline excludes blocked volunteers from that day's
    /// ring set, so a created block takes effect on the next call.
    func createAvailabilityBlock(startDate: Date, endDate: Date, reason: String) async -> Bool {
        guard endDate >= startDate else {
            errorMessage = NSLocalizedString("shifts_availability_invalid_range", comment: "End date must be on or after the start date")
            return false
        }

        errorMessage = nil
        successMessage = nil

        do {
            let trimmedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
            let body = CreateAvailabilityBlockBody(
                encryptedReason: trimmedReason.isEmpty ? nil : trimmedReason,
                endDate: DateFormatting.wireDateString(from: endDate),
                id: UUID().uuidString,
                startDate: DateFormatting.wireDateString(from: startDate)
            )
            let _: Block = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/shifts/availability"),
                body: body
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            await loadAvailabilityBlocks()
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func deleteAvailabilityBlock(id: String) async {
        errorMessage = nil
        successMessage = nil
        do {
            let _: OkResponse = try await apiService.request(
                method: "DELETE",
                path: apiService.hp("/api/shifts/availability/\(id)")
            )
            await loadAvailabilityBlocks()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Timer

    /// Start the elapsed time timer for the active shift.
    private func startTimer() {
        stopTimer()
        timerTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                self?.tick &+= 1
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    /// Stop the elapsed time timer.
    private func stopTimer() {
        timerTask?.cancel()
        timerTask = nil
    }

    /// Match the timer's lifecycle to the clock state of the hub now being browsed.
    private func syncTimer() {
        if isOnShift {
            startTimer()
        } else {
            stopTimer()
        }
    }

    // MARK: - Private Helpers

    private func fetchShifts() async {
        do {
            // Browsing data, so `hp` is right here (unlike the clock paths): the
            // schedule shown is the active hub's. Unscoped, the server resolves the
            // hub to "" and the list comes back empty for every real hub.
            let response: ShiftsListResponse = try await apiService.request(
                method: "GET",
                path: apiService.hp("/api/shifts")
            )
            shifts = response.shifts
            groupShiftsByDay()
        } catch {
            if case APIError.noBaseURL = error {
                // Hub not configured — show empty schedule
            } else if errorMessage == nil {
                // Don't overwrite status error
                errorMessage = error.localizedDescription
            }
            shifts = []
            shiftDays = []
        }
    }

    /// Group shifts by their assigned days for the weekly calendar view.
    private func groupShiftsByDay() {
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        let weekdays = formatter.weekdaySymbols ?? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        let shortWeekdays = formatter.shortWeekdaySymbols ?? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

        let today = Calendar.current.component(.weekday, from: Date()) - 1  // 0-indexed, Sunday = 0

        shiftDays = (0..<7).map { dayIndex in
            let dayShifts = shifts.filter { $0.daysAsInt.contains(dayIndex) }
            return ShiftDay(
                id: dayIndex,
                name: weekdays[dayIndex],
                shortName: shortWeekdays[dayIndex],
                shifts: dayShifts,
                isToday: dayIndex == today
            )
        }
    }


    deinit {
        timerTask?.cancel()
    }
}
