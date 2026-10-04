import SwiftUI

struct AssignmentSheet: View {
    let recordId: String
    let onAssigned: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var viewModel: AssignmentViewModel

    init(recordId: String, apiService: APIService, onAssigned: @escaping () -> Void) {
        self.recordId = recordId
        self.onAssigned = onAssigned
        _viewModel = State(wrappedValue: AssignmentViewModel(apiService: apiService))
    }

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if viewModel.suggestions.isEmpty {
                    ContentUnavailableView(
                        NSLocalizedString("assignment_no_volunteers", comment: "No available volunteers"),
                        systemImage: "person.slash",
                        description: Text(NSLocalizedString("assignment_no_volunteers_hint", comment: "Make sure volunteers are on-shift and have capacity."))
                    )
                } else {
                    List(viewModel.suggestions) { suggestion in
                        SuggestionRow(suggestion: suggestion) {
                            Task {
                                let success = await viewModel.assign(recordId: recordId, pubkey: suggestion.pubkey)
                                if success {
                                    onAssigned()
                                    dismiss()
                                }
                            }
                        }
                        .disabled(viewModel.isAssigning)
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle(NSLocalizedString("assignment_title", comment: "Assign Volunteer"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("common_cancel", comment: "Cancel")) { dismiss() }
                }
            }
        }
        .task { await viewModel.loadSuggestions(for: recordId) }
    }
}

private struct SuggestionRow: View {
    let suggestion: Suggestion
    let onAssign: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(suggestion.pubkey.prefix(4))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .frame(width: 36, height: 36)
                .background(Color.accentColor.opacity(0.1), in: Circle())

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(suggestion.pubkey.prefix(12) + "...")
                        .font(.caption.monospaced())
                    Label("\(Int(suggestion.score))", systemImage: "star.fill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    Label("\(Int(suggestion.activeCaseCount))/\(Int(suggestion.maxCases))", systemImage: "tray.2")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if suggestion.languageScore > 0 {
                        Label(NSLocalizedString("assignment_language_match", comment: "Language"), systemImage: "globe")
                            .font(.caption2)
                            .foregroundStyle(.blue)
                    }
                    if suggestion.specializationScore > 0 {
                        Label("\(suggestion.matchedSpecializations.count) spec", systemImage: "checkmark.seal")
                            .font(.caption2)
                            .foregroundStyle(.green)
                    }
                }
            }

            Spacer()

            Button(NSLocalizedString("assignment_assign_btn", comment: "Assign"), action: onAssign)
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .accessibilityIdentifier("suggestion-row")
    }
}
