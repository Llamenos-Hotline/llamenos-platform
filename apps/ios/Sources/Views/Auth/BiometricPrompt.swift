import LocalAuthentication
import SwiftUI

// MARK: - BiometricType

/// The type of biometric authentication available on this device.
enum BiometricType: Equatable {
    case none
    case faceID
    case touchID
    case opticID

    /// SF Symbol name for this biometric type.
    var systemImageName: String {
        switch self {
        case .none: return "lock"
        case .faceID: return "faceid"
        case .touchID: return "touchid"
        case .opticID: return "opticid"
        }
    }

    /// Localized display name for this biometric type.
    var displayName: String {
        switch self {
        case .none: return NSLocalizedString("biometric_none", comment: "No biometrics")
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        }
    }
}

// MARK: - BiometricPrompt

/// Wrapper around LAContext for biometric authentication (Face ID / Touch ID).
/// Provides a clean async interface and device capability detection.
final class BiometricPrompt {
    /// Detect the biometric type available on this device.
    static var availableType: BiometricType {
        let context = LAContext()
        var error: NSError?

        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return .none
        }

        switch context.biometryType {
        case .none:
            return .none
        case .faceID:
            return .faceID
        case .touchID:
            return .touchID
        case .opticID:
            return .opticID
        @unknown default:
            return .none
        }
    }

    /// Whether any biometric authentication is available.
    static var isAvailable: Bool {
        return availableType != .none
    }

    /// Prompt the user for biometric authentication.
    ///
    /// - Parameter reason: The localized reason string shown in the system prompt.
    /// - Returns: `true` if authentication succeeded, `false` if cancelled or failed.
    static func authenticate(
        reason: String = NSLocalizedString("unlock_biometric_reason", comment: "Unlock Llamenos")
    ) async -> Bool {
        let context = LAContext()
        context.localizedCancelTitle = NSLocalizedString("biometric_cancel", comment: "Use PIN")

        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return false
        }

        do {
            return try await context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: reason
            )
        } catch {
            // User cancelled, biometry lockout, or other failure — all return false.
            return false
        }
    }
}

// MARK: - BiometricButton

/// A button that shows the appropriate biometric icon (Face ID / Touch ID) and
/// triggers the biometric unlock flow when tapped. The caller is responsible for
/// performing the actual LAContext evaluation and Keychain access — this button
/// only provides the UI affordance and triggers the flow.
struct BiometricButton: View {
    let onAuthenticated: () -> Void

    @State private var biometricType: BiometricType = BiometricPrompt.availableType

    var body: some View {
        if biometricType != .none {
            Button {
                onAuthenticated()
            } label: {
                Label {
                    Text(L10n.format("unlock_with_biometric", comment: "Unlock with %@", biometricType.displayName))
                } icon: {
                    Image(systemName: biometricType.systemImageName)
                        .font(.title2)
                }
            }
            .accessibilityIdentifier("biometric-unlock")
            .accessibilityLabel(L10n.format("unlock_with_biometric", comment: "Unlock with %@", biometricType.displayName))
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Biometric Button") {
    VStack(spacing: 20) {
        BiometricButton {
            print("Authenticated!")
        }
    }
    .padding()
}
#endif
