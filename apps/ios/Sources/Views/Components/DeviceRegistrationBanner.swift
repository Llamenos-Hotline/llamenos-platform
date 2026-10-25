import SwiftUI

/// Shown while the server holds no usable registration for this device.
///
/// Until it does, nothing can be sealed to this phone — messages and call details
/// arrive as "No messages yet" — and that looks nothing like its cause, so the
/// failure is stated rather than retried in silence.
struct DeviceRegistrationBanner: View {
    let message: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.orange)
                .accessibilityHidden(true)

            Text(message)
                .font(.subheadline)
                .lineLimit(3)

            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.orange.opacity(0.1))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("device-registration-banner")
    }
}
