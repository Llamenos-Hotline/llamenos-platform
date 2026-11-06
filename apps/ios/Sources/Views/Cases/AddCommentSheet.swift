import SwiftUI

// MARK: - AddCommentSheet

/// Bottom sheet for adding a comment to a case's timeline.
/// Comment is encrypted before submission via E2EE.
///
/// `onSubmit` answers nil once the comment is saved — the presenter then closes the
/// sheet — or the error to show. On an error the sheet stays open with the text intact,
/// so a comment that was not saved can never look as if it was (#2478).
struct AddCommentSheet: View {
    let onSubmit: (String) async -> String?

    @Environment(\.dismiss) private var dismiss
    @State private var commentText: String = ""
    @State private var isSubmitting: Bool = false
    @State private var submitError: String?

    private var canSubmit: Bool {
        !commentText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSubmitting
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                TextEditor(text: $commentText)
                    .font(.brand(.body))
                    .frame(minHeight: 120)
                    .padding(8)
                    .background(Color.brandMuted.opacity(0.3))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(Color.brandBorder, lineWidth: 1)
                    )
                    .accessibilityIdentifier("comment-input")

                HStack {
                    Image(systemName: "lock.fill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(NSLocalizedString("cases_comment_encrypted", comment: "Comments are encrypted end-to-end"))
                        .font(.brand(.caption2))
                        .foregroundStyle(.secondary)
                }

                if let submitError {
                    Text(submitError)
                        .font(.brand(.footnote))
                        .foregroundStyle(Color.brandDestructive)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("comment-submit-error")
                }

                Spacer()
            }
            .padding()
            .navigationTitle(NSLocalizedString("cases_add_comment", comment: "Add Comment"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("common_cancel", comment: "Cancel")) {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        // Belt and braces: even if the disabled state does not
                        // reach the toolbar control, an empty comment must
                        // never submit.
                        guard canSubmit else { return }
                        isSubmitting = true
                        submitError = nil
                        let text = commentText.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task {
                            submitError = await onSubmit(text)
                            isSubmitting = false
                        }
                    } label: {
                        if isSubmitting {
                            ProgressView()
                        } else {
                            Text(NSLocalizedString("cases_comment_submit", comment: "Submit"))
                        }
                    }
                    .disabled(!canSubmit)
                    .accessibilityIdentifier("comment-submit")
                }
            }
        }
        .accessibilityIdentifier("add-comment-sheet")
    }
}
