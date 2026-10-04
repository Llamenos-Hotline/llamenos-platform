import Foundation
import LocalAuthentication

// MARK: - PINMode

/// The mode of the PIN pad: setting a new PIN or unlocking with an existing one.
enum PINMode: Equatable {
    /// User is creating a new PIN (enter + confirm).
    case set
    /// User is entering their PIN to unlock.
    case unlock
}

// MARK: - PINPhase

/// Sub-phases within PIN set mode.
enum PINPhase: Equatable {
    /// First entry of new PIN.
    case enter
    /// Confirming the new PIN matches.
    case confirm
}

// MARK: - PINLockout

/// Escalating lockout policy for failed PIN attempts.
/// Attempts 1-4: no lockout. 5-6: 30s. 7-8: 2min. 9: 10min. 10+: wipe all keys.
enum PINLockout {
    /// Failed attempts allowed before the keys are wiped.
    static let maxAttempts = 10

    /// Compute the lockout duration for the given number of failed attempts.
    /// Returns nil for no lockout, 0 for wipe (terminal).
    static func lockoutDuration(forAttempts attempts: Int) -> TimeInterval? {
        switch attempts {
        case 0...4: return nil
        case 5...6: return 30
        case 7...8: return 120
        case 9: return 600
        default: return 0  // 10+ = wipe
        }
    }

    /// Whether the given attempt count triggers a full key wipe.
    static func shouldWipeKeys(forAttempts attempts: Int) -> Bool {
        return attempts >= maxAttempts
    }
}

// MARK: - PINViewModel

/// View model for PIN entry, both for setting a new PIN and unlocking with an existing one.
/// Handles the enter-then-confirm flow for new PINs, PIN validation, escalating lockout,
/// and biometric unlock via Keychain-stored PIN (C5/H7).
@Observable
final class PINViewModel {
    private let authService: AuthService
    private let keychainService: KeychainService
    private let onSuccess: () -> Void

    /// Current mode (set or unlock).
    let mode: PINMode

    /// Current PIN digits entered by the user.
    var pin: String = ""

    /// PIN length (6 or 8 digits).
    private(set) var maxLength: Int

    /// For set mode: the phase within the set flow.
    var phase: PINPhase = .enter

    /// The first PIN entry (during set mode), used for confirmation comparison.
    private var firstEntry: String?

    /// Error message to display.
    var errorMessage: String?

    /// Whether an async operation is in progress (PIN verification).
    var isLoading: Bool = false

    /// Number of failed unlock attempts. The Keychain is the sole source of truth
    /// (H7) — this reads live on every access rather than caching a snapshot from
    /// `init`, so a write from another code path (e.g. `AuthService.logout()`
    /// clearing lockout state while this view model is still on screen) is
    /// observed immediately instead of through a stale in-memory copy. A stale
    /// lockout read is a security defect here, not a display glitch: it is the
    /// control that protects a seized device.
    var failedAttempts: Int {
        guard mode == .unlock else { return 0 }
        return keychainService.getLockoutAttempts()
    }

    /// Lockout expiry time. Same live-read rationale as `failedAttempts`.
    var lockoutUntil: Date {
        guard mode == .unlock else { return .distantPast }
        return keychainService.getLockoutUntil()
    }

    /// Whether biometric unlock is available and enabled.
    var isBiometricAvailable: Bool {
        mode == .unlock && authService.isBiometricEnabled && BiometricPrompt.isAvailable
    }

    /// Title text for the current PIN entry state.
    var titleText: String {
        switch mode {
        case .set:
            switch phase {
            case .enter:
                return NSLocalizedString("pin_set_title", comment: "Create a PIN")
            case .confirm:
                return NSLocalizedString("pin_confirm_title", comment: "Confirm your PIN")
            }
        case .unlock:
            return NSLocalizedString("pin_unlock_title", comment: "Enter your PIN")
        }
    }

    /// Subtitle text providing additional context.
    var subtitleText: String {
        switch mode {
        case .set:
            switch phase {
            case .enter:
                return NSLocalizedString("pin_set_subtitle", comment: "Choose a PIN (8+ digits) or passphrase (8+ characters)")
            case .confirm:
                return NSLocalizedString("pin_confirm_subtitle", comment: "Enter the same PIN again to confirm")
            }
        case .unlock:
            if isLockedOut {
                let remaining = Int(lockoutUntil.timeIntervalSinceNow.rounded(.up))
                return L10n.format("pin_lockout_remaining", comment: "Locked out. Try again in %d seconds.", max(remaining, 0))
            }
            if failedAttempts > 0 {
                return L10n.format(
                    "pin_unlock_attempts",
                    comment: "N of M attempts used",
                    failedAttempts,
                    PINLockout.maxAttempts
                )
            }
            return NSLocalizedString("pin_unlock_subtitle", comment: "Enter your PIN to unlock")
        }
    }

    /// Whether the user is temporarily locked out due to too many failed attempts.
    var isLockedOut: Bool {
        lockoutUntil > Date()
    }

    init(
        mode: PINMode,
        authService: AuthService,
        keychainService: KeychainService? = nil,
        maxLength: Int = 8,
        onSuccess: @escaping () -> Void
    ) {
        self.mode = mode
        self.authService = authService
        self.keychainService = keychainService ?? authService.keychainService
        self.maxLength = maxLength
        self.onSuccess = onSuccess
    }

    // MARK: - Lockout State Persistence (H7)

    /// Clear lockout state on successful unlock. `failedAttempts`/`lockoutUntil`
    /// read straight from the Keychain, so clearing it there is the whole fix —
    /// there is no in-memory copy left to reset separately.
    private func clearLockoutState() {
        keychainService.clearLockoutState()
    }

    // MARK: - PIN Length

    /// Update the max PIN length. Only valid during set mode, enter phase.
    func updateMaxLength(_ newLength: Int) {
        guard mode == .set, phase == .enter else { return }
        maxLength = newLength
    }

    // MARK: - PIN Completion

    /// Called when the user finishes entering a PIN (all digits entered).
    func onPINComplete(_ enteredPIN: String) {
        errorMessage = nil

        switch mode {
        case .set:
            handleSetPIN(enteredPIN)
        case .unlock:
            handleUnlockPIN(enteredPIN)
        }
    }

    // MARK: - Set PIN Flow

    private func handleSetPIN(_ enteredPIN: String) {
        switch phase {
        case .enter:
            // Validate PIN format
            do {
                try authService.validatePIN(enteredPIN)
            } catch {
                errorMessage = error.localizedDescription
                pin = ""
                return
            }

            // Store first entry and move to confirm phase
            firstEntry = enteredPIN
            pin = ""
            phase = .confirm

        case .confirm:
            guard let firstEntry else {
                errorMessage = NSLocalizedString("error_pin_internal", comment: "Internal error. Please try again.")
                resetToEnter()
                return
            }

            // Check PINs match
            guard enteredPIN == firstEntry else {
                errorMessage = NSLocalizedString("error_pin_mismatch", comment: "PINs do not match. Try again.")
                resetToEnter()
                return
            }

            // PINs match — generate device keys and encrypt with this PIN atomically
            isLoading = true
            do {
                let enableBiometric = BiometricPrompt.isAvailable
                _ = try authService.createNewIdentity(pin: enteredPIN, enableBiometric: enableBiometric)

                isLoading = false
                onSuccess()
            } catch {
                isLoading = false
                errorMessage = error.localizedDescription
                resetToEnter()
            }
        }
    }

    // MARK: - Unlock PIN Flow

    private func handleUnlockPIN(_ enteredPIN: String) {
        guard !isLockedOut else {
            errorMessage = NSLocalizedString("error_pin_locked_out", comment: "Too many attempts. Please wait.")
            return
        }

        isLoading = true
        do {
            try authService.unlockWithPIN(enteredPIN)
            isLoading = false
            clearLockoutState()
            onSuccess()
        } catch {
            isLoading = false
            keychainService.setLockoutAttempts(failedAttempts + 1)
            pin = ""

            // Apply escalating lockout (H7)
            handleFailedAttempt()
        }
    }

    /// Apply escalating lockout policy after a failed PIN attempt (H7).
    private func handleFailedAttempt() {
        if PINLockout.shouldWipeKeys(forAttempts: failedAttempts) {
            // Terminal: wipe all keys
            errorMessage = NSLocalizedString(
                "error_pin_wiped",
                comment: "Too many failed attempts. All keys have been wiped for security."
            )
            clearLockoutState()
            authService.logout()
            return
        }

        if let duration = PINLockout.lockoutDuration(forAttempts: failedAttempts) {
            keychainService.setLockoutUntil(Date().addingTimeInterval(duration))
            errorMessage = L10n.format(
                "error_pin_lockout_duration",
                comment: "Too many failed attempts. Locked for %d seconds.",
                Int(duration)
            )
        } else {
            errorMessage = NSLocalizedString("error_pin_incorrect", comment: "Incorrect PIN. Please try again.")
        }
    }

    // MARK: - Biometric Unlock (C5)

    /// Attempt biometric unlock. Evaluates biometrics via LAContext, then retrieves
    /// the PIN from the biometric-protected Keychain item using the authenticated
    /// context (kSecUseAuthenticationContext) — one biometric prompt, no double challenge.
    func attemptBiometricUnlock() {
        guard isBiometricAvailable else { return }

        Task { @MainActor in
            let context = LAContext()
            var canEvalError: NSError?
            guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &canEvalError) else {
                return
            }

            let reason = NSLocalizedString(
                "biometric_unlock_reason",
                comment: "Authenticate to unlock Llamenos"
            )

            do {
                let success = try await context.evaluatePolicy(
                    .deviceOwnerAuthenticationWithBiometrics,
                    localizedReason: reason
                )
                guard success else { return }

                // Biometric succeeded — retrieve PIN using the authenticated context
                // so the Keychain does not prompt for biometrics a second time.
                if let pin = try keychainService.retrievePINWithBiometric(context: context) {
                    isLoading = true
                    do {
                        try authService.unlockWithPIN(pin)
                        isLoading = false
                        clearLockoutState()
                        onSuccess()
                    } catch {
                        isLoading = false
                        // Biometric succeeded but PIN failed (key may have been re-encrypted
                        // with a different PIN after biometrics changed). Fall back to manual PIN.
                        errorMessage = NSLocalizedString(
                            "error_biometric_pin_mismatch",
                            comment: "Biometric unlock failed. Please enter your PIN."
                        )
                    }
                }
                // nil = no stored PIN (biometric not set up) — fall back to PIN pad
            } catch let laError as LAError {
                switch laError.code {
                case .userCancel, .userFallback, .systemCancel, .appCancel, .notInteractive:
                    // User cancelled or chose PIN — fall back to PIN pad silently
                    break
                case .biometryLockout:
                    errorMessage = NSLocalizedString(
                        "error_biometric_lockout",
                        comment: "Biometric authentication is locked out. Please enter your PIN."
                    )
                case .biometryNotEnrolled:
                    // Biometrics removed/changed since setup — invalidate stored PIN so
                    // the next enrollment doesn't silently reuse the old stored PIN.
                    keychainService.deleteBiometricPIN()
                    try? authService.setBiometricEnabled(false)
                    errorMessage = NSLocalizedString(
                        "error_biometric_not_enrolled",
                        comment: "Biometric enrollment changed. Please enter your PIN."
                    )
                default:
                    // Other LAError — fall back to PIN pad silently
                    break
                }
            } catch {
                // Non-LAError (e.g. Keychain error) — fall back to PIN pad silently
            }
        }
    }

    // MARK: - Reset

    /// Reset to the initial enter phase (after mismatch or error).
    private func resetToEnter() {
        firstEntry = nil
        pin = ""
        phase = .enter
    }

    /// Full reset of the view model. `failedAttempts`/`lockoutUntil` are Keychain-backed
    /// reads, so resetting them means clearing the Keychain record, not an in-memory
    /// field — otherwise this method would silently stop doing what its name promises.
    func reset() {
        pin = ""
        firstEntry = nil
        phase = .enter
        errorMessage = nil
        isLoading = false
        clearLockoutState()
    }
}
