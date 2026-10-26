import SwiftUI

/// Shown while the app could not ask the server what this user may do.
///
/// A failed refresh keeps the access the user last had, or — if the server never
/// answered this session — shows the least access. Either way the screen would
/// otherwise look like the truth, so the failure is stated until the server answers.
struct PermissionsRefreshBanner: View {
    let failure: PermissionService.RefreshFailure

    private var message: String {
        switch failure {
        case .keptLastKnown:
            return NSLocalizedString("error_permissions_stale", comment: "Permissions refresh failed; last known access kept")
        case .noneKnown:
            return NSLocalizedString("error_permissions_unavailable", comment: "Permissions could not be loaded; gated features hidden")
        }
    }

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
        .accessibilityIdentifier("permissions-refresh-banner")
    }
}
