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
    private let cryptoService: CryptoService
    private let hubContext: HubContext
    private let linphoneService: any LinphoneServiceProtocol

    // MARK: - Public State

    /// All shifts from the server.
    var shifts: [Shift] = []

    /// Shifts grouped by day of week for the calendar view.
    var shiftDays: [ShiftDay] = []

    /// Current shift status from the server.
    var isOnShift: Bool = false

    /// The ID of the current active shift, if any.
    var activeShiftId: String?

    /// When the current shift started, for the elapsed timer.
    var shiftStartedAt: Date?

    /// Number of active calls during the current shift.
    var activeCallCount: Int = 0

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
        guard let startedAt = shiftStartedAt else { return "--:--:--" }
        let elapsed = Date().timeIntervalSince(startedAt)
        let hours = Int(elapsed) / 3600
        let minutes = (Int(elapsed) % 3600) / 60
        let seconds = Int(elapsed) % 60
        return String(format: "%02d:%02d:%02d", hours, minutes, seconds)
    }

    // MARK: - Private State

    private var timerTask: Task<Void, Never>?

    // MARK: - Initialization

    init(
        apiService: APIService,
        cryptoService: CryptoService,
        hubContext: HubContext,
        linphoneService: any LinphoneServiceProtocol
    ) {
        self.apiService = apiService
        self.cryptoService = cryptoService
        self.hubContext = hubContext
        self.linphoneService = linphoneService
    }

    // MARK: - SIP Account Lifecycle

    /// Register a SIP account with Linphone for the given hub. Called after clock-in succeeds.
    func onShiftStarted(hubId: String, sipParams: SipTokenResponse) async {
        do {
            try linphoneService.registerHubAccount(hubId: hubId, sipParams: sipParams)
        } catch {}
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

        async let statusResult: Void = fetchShiftStatus()
        async let shiftsResult: Void = fetchShifts()

        await statusResult
        await shiftsResult

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
        isTogglingShift = true
        errorMessage = nil
        successMessage = nil

        do {
            let response: ClockInResponse = try await apiService.request(
                method: "POST",
                path: "/api/shifts/clock-in"
            )

            isOnShift = true
            activeShiftId = response.shiftId
            shiftStartedAt = Date()
            startTimer()

            // Register a SIP account so the volunteer receives VoIP calls for this hub.
            if let hubId = hubContext.activeHubId,
               let sipParams = try? await apiService.getSipToken(hubId: hubId) {
                await onShiftStarted(hubId: hubId, sipParams: sipParams)
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
        isTogglingShift = true
        errorMessage = nil
        successMessage = nil

        do {
            let _: ClockOutResponse = try await apiService.request(
                method: "POST",
                path: "/api/shifts/clock-out"
            )

            isOnShift = false
            activeShiftId = nil
            shiftStartedAt = nil
            stopTimer()

            // Unregister the SIP account so the volunteer stops receiving VoIP calls.
            if let hubId = hubContext.activeHubId {
                onShiftEnded(hubId: hubId)
            }

            let generator = UIImpactFeedbackGenerator(style: .light)
            generator.impactOccurred()

            successMessage = NSLocalizedString("shifts_clocked_out", comment: "You are now off shift")
        } catch {
            errorMessage = error.localizedDescription
        }

        isTogglingShift = false
    }

    /// Sign up for a specific shift.
    func signUp(for shift: Shift) async {
        guard let pubkey = cryptoService.pubkey else {
            errorMessage = NSLocalizedString("error_no_key_loaded", comment: "No key loaded")
            return
        }

        errorMessage = nil
        successMessage = nil

        do {
            let request = ShiftSignupRequest(pubkey: pubkey)
            try await apiService.request(
                method: "POST",
                path: "/api/shifts/\(shift.id)/signup",
                body: request
            )

            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)

            successMessage = L10n.format("shifts_signed_up", comment: "Signed up for %@", shift.encryptedName.isEmpty ? shift.timeRangeDisplay : shift.encryptedName)

            // Reload to show updated volunteer count
            await fetchShifts()
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
                // The @Observable property `elapsedTimeDisplay` is computed,
                // so we trigger observation by touching shiftStartedAt
                self?.objectWillChange()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    /// Stop the elapsed time timer.
    private func stopTimer() {
        timerTask?.cancel()
        timerTask = nil
    }

    /// Manually trigger observation for computed properties.
    private func objectWillChange() {
        // Touch a stored property to trigger @Observable change tracking
        let _ = isOnShift
    }

    // MARK: - Private Helpers

    private func fetchShiftStatus() async {
        do {
            let status: ShiftStatusResponse = try await apiService.request(
                method: "GET",
                path: "/api/shifts/my-status"
            )
            isOnShift = status.onShift
            activeShiftId = status.shiftId
            activeCallCount = status.activeCallCount ?? 0

            if status.onShift, let startedAtString = status.startedAt {
                shiftStartedAt = DateFormatting.parseISO(startedAtString)
                startTimer()
            } else {
                shiftStartedAt = nil
                stopTimer()
            }
        } catch {
            if case APIError.noBaseURL = error {
                // Hub not configured — show off-shift, no error
            } else {
                errorMessage = error.localizedDescription
            }
            isOnShift = false
        }
    }

    private func fetchShifts() async {
        do {
            let response: ShiftsListResponse = try await apiService.request(
                method: "GET",
                path: "/api/shifts"
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
