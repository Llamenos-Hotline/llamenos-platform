import Foundation
import os
import UIKit

// MARK: - ShiftsViewModel

/// View model for the Shifts tab. Manages shift schedule display, clock in/out toggle,
/// and shift signup. Groups shifts by day for the weekly calendar view.
///
/// SIP integration: when the volunteer clocks in, `registerSipAccountsForMemberHubs` fetches
/// SIP credentials from `/api/telephony/sip-token` and registers them for EVERY hub the
/// volunteer belongs to — not only the active one (multi-hub routing axiom). On clock out,
/// every registration is dropped. Failures are surfaced in `voipWarning`, never swallowed.
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

    /// Set when in-app calling is not working after clock-in — SDK missing, credentials
    /// refused or undecodable, registration failed — so the volunteer knows calls will not
    /// ring this device. nil when every member hub was registered.
    var voipWarning: String?

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
    private let logger = Logger(subsystem: "org.llamenos.hotline", category: "SIP")

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

    /// Register SIP accounts for every member hub. Called after clock-in succeeds.
    ///
    /// Calls for any member hub must be able to ring this device regardless of which hub
    /// is active, so this enumerates the volunteer's hubs (`GET /api/hubs`) and registers
    /// each one. `/api/telephony/sip-token` is not hub-scoped, so it is fetched once.
    func registerSipAccountsForMemberHubs() async {
        voipWarning = nil

        let sipParams: SipTokenResponse
        do {
            sipParams = try await apiService.getSipToken()
        } catch APIError.requestFailed(let statusCode, let body) where statusCode == 400 || statusCode == 404 {
            // The server refuses SIP credentials: the volunteer's call preference is
            // "phone" (the server default when unset), or no SIP-capable provider is
            // configured. Not a client failure, but calls will not ring this device —
            // say so rather than leaving the volunteer to assume they will.
            logger.notice("SIP credentials refused (HTTP \(statusCode)): \(body, privacy: .public)")
            voipWarning = NSLocalizedString(
                "shifts_voip_not_enabled",
                comment: "In-app calling is not turned on for this account"
            )
            return
        } catch {
            logger.error("SIP credential fetch failed: \(error.localizedDescription, privacy: .public)")
            voipWarning = Self.voipSetupFailedMessage
            return
        }

        let hubIds: [String]
        do {
            let response: HubsListResponse = try await apiService.request(method: "GET", path: "/api/hubs")
            hubIds = response.hubs.filter { $0.status == .active }.map(\.id)
        } catch {
            logger.error("Member hub enumeration failed: \(error.localizedDescription, privacy: .public)")
            voipWarning = Self.voipSetupFailedMessage
            return
        }

        var failedHubCount = 0
        for hubId in hubIds {
            do {
                try linphoneService.registerHubAccount(hubId: hubId, sipParams: sipParams)
            } catch LinphoneError.sdkNotLinked {
                logger.error("SIP registration impossible: Linphone SDK is not linked into this build")
                voipWarning = NSLocalizedString(
                    "shifts_voip_unavailable_in_build",
                    comment: "In-app calling is not included in this build"
                )
                return
            } catch {
                failedHubCount += 1
                logger.error("SIP registration failed for hub \(hubId, privacy: .private): \(error.localizedDescription, privacy: .public)")
            }
        }
        if failedHubCount > 0 {
            voipWarning = Self.voipSetupFailedMessage
        }
    }

    /// Drop every SIP registration. Called after clock-out succeeds — clock-out ends the
    /// shift for all hubs, so no member hub may keep ringing this device.
    func unregisterAllSipAccounts() {
        linphoneService.unregisterAllHubAccounts()
        voipWarning = nil
    }

    private static var voipSetupFailedMessage: String {
        NSLocalizedString(
            "shifts_voip_setup_failed",
            comment: "In-app calling could not be set up; calls will not ring this device"
        )
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

            // Register SIP accounts so VoIP calls from every member hub can ring this device.
            await registerSipAccountsForMemberHubs()

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

            // Drop every SIP registration so no hub keeps ringing this device off shift.
            unregisterAllSipAccounts()

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

            successMessage = String(
                format: NSLocalizedString("shifts_signed_up", comment: "Signed up for %@"),
                shift.encryptedName.isEmpty ? shift.timeRangeDisplay : shift.encryptedName
            )

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
