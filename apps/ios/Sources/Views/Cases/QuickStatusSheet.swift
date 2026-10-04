import SwiftUI

// MARK: - QuickStatusSheet

/// Bottom sheet for quickly changing a case's status.
/// Shows template-defined status options with color indicators.
struct QuickStatusSheet: View {
    let currentStatus: String
    let statuses: [CaseEnumOption]
    let onSelect: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(statuses.sorted { $0.order < $1.order }) { status in
                    Button {
                        onSelect(status.value)
                    } label: {
                        HStack(spacing: 10) {
                            Circle()
                                .fill(Color(hex: status.color ?? "#6b7280") ?? .gray)
                                .frame(width: 10, height: 10)

                            Text(status.label)
                                .font(.brand(.body))
                                .foregroundStyle(.primary)

                            Spacer()

                            if status.value == currentStatus {
                                Image(systemName: "checkmark")
                                    .font(.brand(.body))
                                    .foregroundStyle(Color.brandPrimary)
                            }

                            if status.isClosed == true {
                                Text(NSLocalizedString("cases_status_closed", comment: "Closed"))
                                    .font(.brand(.caption2))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color.brandMuted)
                                    .clipShape(Capsule())
                            }
                        }
                    }
                    .accessibilityIdentifier("status-option-\(status.value)")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(NSLocalizedString("cases_change_status", comment: "Change Status"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("common_cancel", comment: "Cancel")) {
                        dismiss()
                    }
                }
            }
        }
        .accessibilityIdentifier("quick-status-sheet")
    }
}
