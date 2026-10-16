import SwiftUI

struct BrandEmptyState: View {
    let icon: String
    let title: String
    let message: String
    var action: (() -> Void)? = nil
    var actionLabel: String? = nil
    var actionAccessibilityID: String? = nil
    /// Identifier for the accessibility container this view owns. It must be set
    /// here rather than layered on from the call site: the container is created
    /// by `accessibilityElement(children: .contain)` below, so an identifier
    /// applied outside this view never reaches the element that answers queries.
    var accessibilityID: String? = nil

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: icon)
                .font(.system(size: 48))
                .foregroundStyle(Color.brandMutedForeground)

            Text(title)
                .font(.brand(.headline))
                .foregroundStyle(Color.brandForeground)

            Text(message)
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
                .multilineTextAlignment(.center)

            if let action, let actionLabel {
                Button(action: action) {
                    Text(actionLabel)
                        .font(.brand(.subheadline))
                        .fontWeight(.semibold)
                }
                .buttonStyle(.borderedProminent)
                .tint(.brandPrimary)
                .optionalAccessibilityIdentifier(actionAccessibilityID)
            }
        }
        .padding(32)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(accessibilityID ?? "brand-empty-state")
    }
}

// MARK: - Optional Accessibility ID

private extension View {
    @ViewBuilder
    func optionalAccessibilityIdentifier(_ id: String?) -> some View {
        if let id {
            self.accessibilityIdentifier(id)
        } else {
            self
        }
    }
}
