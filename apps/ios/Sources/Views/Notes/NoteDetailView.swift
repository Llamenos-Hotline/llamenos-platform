import SwiftUI

// MARK: - NoteDetailView

/// Full-screen detail view for a single decrypted note. Shows the complete note text,
/// custom field values, and metadata. Supports copy-to-clipboard.
struct NoteDetailView: View {
    let note: DecryptedNote
    let customFields: [CustomFieldsListResponseField]

    @State private var showCopyConfirmation: Bool = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // Note text
                noteTextSection

                // Custom fields
                if let fields = note.payload.fields, !fields.isEmpty {
                    customFieldsSection(fields)
                }

                // Metadata
                metadataSection

                Spacer(minLength: 40)
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
        }
        .navigationTitle(NSLocalizedString("note_detail_title", comment: "Note"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button {
                        copyNoteText()
                    } label: {
                        Label(
                            NSLocalizedString("note_copy_text", comment: "Copy Text"),
                            systemImage: "doc.on.doc"
                        )
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityIdentifier("note-detail-menu")
            }
        }
        .overlay(alignment: .bottom) {
            if showCopyConfirmation {
                copyConfirmationBanner
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .accessibilityIdentifier("note-detail-view")
    }

    // MARK: - Note Text Section

    private var noteTextSection: some View {
        BrandCard {
            VStack(alignment: .leading, spacing: 8) {
                Text(note.payload.text)
                    .font(.brand(.body))
                    .foregroundStyle(Color.brandForeground)
                    .textSelection(.enabled)
                    .privacySensitive()  // M28: Redact note content in screenshots
                    .accessibilityIdentifier("note-detail-text")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Custom Fields Section

    @ViewBuilder
    private func customFieldsSection(_ fields: [String: AnyCodableValue]) -> some View {
        BrandCard {
            VStack(alignment: .leading, spacing: 12) {
                Text(NSLocalizedString("note_detail_fields", comment: "Details"))
                    .font(.brand(.headline))
                    .foregroundStyle(Color.brandForeground)
                    .accessibilityIdentifier("note-detail-fields-header")

                ForEach(orderedFields(fields), id: \.key) { field in
                    LabeledContent {
                        Text(field.value.displayValue)
                            .font(.brand(.body))
                            .foregroundStyle(Color.brandForeground)
                            .multilineTextAlignment(.trailing)
                            .privacySensitive()  // M28: Redact custom field values in screenshots
                    } label: {
                        Text(labelForField(named: field.key))
                            .font(.brand(.subheadline))
                            .foregroundStyle(Color.brandMutedForeground)
                    }
                    .accessibilityIdentifier("note-field-\(field.key)")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Metadata Section

    private var metadataSection: some View {
        BrandCard {
            VStack(alignment: .leading, spacing: 12) {
                Text(NSLocalizedString("note_detail_metadata", comment: "Info"))
                    .font(.brand(.headline))
                    .foregroundStyle(Color.brandForeground)

                // Author
                LabeledContent {
                    Text(note.authorDisplayName)
                        .font(.brandMono(.body))
                        .foregroundStyle(Color.brandForeground)
                } label: {
                    Text(NSLocalizedString("note_detail_author", comment: "Author"))
                        .foregroundStyle(Color.brandMutedForeground)
                }
                .accessibilityIdentifier("note-detail-author")

                // Created date
                LabeledContent {
                    Text(note.createdAt.formatted(date: .long, time: .shortened))
                        .font(.brand(.footnote))
                        .foregroundStyle(Color.brandMutedForeground)
                } label: {
                    Text(NSLocalizedString("note_detail_created", comment: "Created"))
                        .foregroundStyle(Color.brandMutedForeground)
                }
                .accessibilityIdentifier("note-detail-created")

                // Updated date
                if let updatedAt = note.updatedAt {
                    LabeledContent {
                        Text(updatedAt.formatted(date: .long, time: .shortened))
                            .font(.brand(.footnote))
                            .foregroundStyle(Color.brandMutedForeground)
                    } label: {
                        Text(NSLocalizedString("note_detail_updated", comment: "Updated"))
                            .foregroundStyle(Color.brandMutedForeground)
                    }
                }

                // Call ID — copyable
                if let callId = note.callId {
                    CopyableField(
                        label: NSLocalizedString("note_detail_call", comment: "Call"),
                        value: callId
                    )
                    .accessibilityIdentifier("note-detail-call")
                }

                // Conversation ID — copyable
                if let conversationId = note.conversationId {
                    CopyableField(
                        label: NSLocalizedString("note_detail_conversation", comment: "Conversation"),
                        value: conversationId
                    )
                    .accessibilityIdentifier("note-detail-conversation")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Copy Confirmation Banner

    private var copyConfirmationBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color.brandPrimary)
            Text(NSLocalizedString("note_copied", comment: "Note text copied"))
                .font(.brand(.subheadline))
                .fontWeight(.medium)
                .foregroundStyle(Color.brandForeground)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(
            Capsule()
                .fill(Color.brandCard)
                .shadow(color: .black.opacity(0.08), radius: 8)
        )
        .overlay(
            Capsule()
                .stroke(Color.brandBorder, lineWidth: 1)
        )
        .padding(.bottom, 16)
        .accessibilityIdentifier("copy-confirmation")
    }

    // MARK: - Helpers

    private func copyNoteText() {
        UIPasteboard.general.string = note.payload.text

        let generator = UINotificationFeedbackGenerator()
        generator.notificationOccurred(.success)

        withAnimation(.easeInOut(duration: 0.3)) {
            showCopyConfirmation = true
        }

        Task {
            try? await Task.sleep(for: .seconds(2))
            withAnimation(.easeInOut(duration: 0.3)) {
                showCopyConfirmation = false
            }
        }
    }

    /// Get the display label for a custom field by its name.
    private func labelForField(named name: String) -> String {
        customFields.first { $0.name == name }?.label ?? name
    }

    /// Order fields according to their definition order.
    private func orderedFields(_ fields: [String: AnyCodableValue]) -> [(key: String, value: AnyCodableValue)] {
        let fieldOrder = Dictionary(uniqueKeysWithValues: customFields.map { ($0.name, $0.orderOrZero) })
        return fields.sorted { lhs, rhs in
            let lhsOrder = fieldOrder[lhs.key] ?? Int.max
            let rhsOrder = fieldOrder[rhs.key] ?? Int.max
            return lhsOrder < rhsOrder
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Note Detail") {
    NavigationStack {
        NoteDetailView(
            note: DecryptedNote(
                id: "preview-1",
                payload: NotePayload(
                    text: "Caller reported feeling anxious about upcoming court date. Discussed breathing exercises and provided information about local legal aid resources. Follow-up recommended within 48 hours.",
                    fields: [
                        "severity": .int(3),
                        "category": .string("Legal"),
                        "followUp": .bool(true),
                    ]
                ),
                authorPubkey: "preview_pubkey_0000000000000000000000000000000000000000000000000001",
                callId: "call-12345-abcde",
                conversationId: nil,
                createdAt: Date().addingTimeInterval(-3600),
                updatedAt: nil
            ),
            customFields: [
                CustomFieldsListResponseField(
                    name: "severity", label: "Severity", type: .number,
                    required: true, order: 0
                ),
                CustomFieldsListResponseField(
                    name: "category", label: "Category", type: .select,
                    required: false, options: ["Legal", "Medical", "Housing"],
                    order: 1
                ),
                CustomFieldsListResponseField(
                    name: "followUp", label: "Follow-up Needed", type: .checkbox,
                    required: false, order: 2
                ),
            ]
        )
    }
}
#endif
