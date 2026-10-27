import SwiftUI

/// Last step of enrolment by invite: redeeming it with the device keys just created.
///
/// Shown in place of the PIN screen once the PIN is confirmed. While the request is in
/// flight it says so; if the hub refuses or cannot be reached it says why and offers a
/// retry, or carrying on without enrolling. The invite stays pending across retries.
struct InviteRedeemView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        let enrollment = appState.inviteEnrollment

        VStack(spacing: 20) {
            if let error = enrollment.redeemError, !enrollment.isRedeeming {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 36))
                    .foregroundStyle(.red)
                    .accessibilityHidden(true)

                Text(NSLocalizedString("enroll_failed_title", comment: "Couldn't enroll"))
                    .font(.brand(.title2))
                    .fontWeight(.bold)
                    .accessibilityAddTraits(.isHeader)

                Text(error)
                    .font(.brand(.subheadline))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("invite-redeem-error")

                Button(NSLocalizedString("enroll_retry", comment: "Retry")) {
                    Task { await appState.completeEnrollment() }
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("invite-redeem-retry")

                Button(NSLocalizedString("enroll_continue_without", comment: "Continue without enrolling")) {
                    appState.continueWithoutEnrolling()
                }
                .accessibilityIdentifier("invite-redeem-continue")
            } else {
                ProgressView()
                    .accessibilityIdentifier("invite-redeem-progress")

                Text(NSLocalizedString("enroll_redeeming", comment: "Joining the hub…"))
                    .font(.brand(.subheadline))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("invite-redeem")
        .navigationBarBackButtonHidden()
    }
}
