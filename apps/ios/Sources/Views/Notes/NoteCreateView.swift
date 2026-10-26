import SwiftUI

// MARK: - NoteCreateView

/// Sheet view for creating a new encrypted note. Includes a text editor for the note body
/// and dynamically renders custom field inputs based on the field definitions from the server.
///
/// A note belongs to a call, chosen from `choices` — never typed: the server accepts only a
/// real call of the hub (#2125), and iOS never shows a volunteer a call's id.
struct NoteCreateView: View {
    let customFields: [CustomFieldsListResponseField]
    /// The calls the note can be filed against.
    let choices: [CallReference]
    /// Whether more choices are still being fetched.
    var isLoadingChoices: Bool = false
    /// Why the choices could not be fetched, if they could not.
    var choicesError: String?
    /// Called with the note text, custom field values, the chosen call and any attached transcript.
    let onSave: (String, [String: AnyCodableValue]?, CallReference, String?) async throws -> Void
    var transcriptionService: TranscriptionService?

    @Environment(\.dismiss) private var dismiss

    @State private var noteText: String = ""
    @State private var fieldValues: [String: AnyCodableValue] = [:]
    @State private var selectedCallId: String?
    @State private var isSaving: Bool = false
    @State private var errorMessage: String?
    @State private var attachedTranscript: String?

    private var trimmedText: String { noteText.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var selectedCall: CallReference? { choices.first { $0.id == selectedCallId } }

    /// Save needs the note text and the call it is about.
    private var canSave: Bool { !trimmedText.isEmpty && selectedCall != nil && !isSaving }

    /// - Parameter initialCall: The call the note is prefilled with (it must be in `choices`).
    init(
        customFields: [CustomFieldsListResponseField],
        choices: [CallReference],
        initialCall: CallReference? = nil,
        isLoadingChoices: Bool = false,
        choicesError: String? = nil,
        transcriptionService: TranscriptionService? = nil,
        onSave: @escaping (String, [String: AnyCodableValue]?, CallReference, String?) async throws -> Void
    ) {
        self.customFields = customFields
        self.choices = choices
        self.isLoadingChoices = isLoadingChoices
        self.choicesError = choicesError
        self.transcriptionService = transcriptionService
        self.onSave = onSave
        _selectedCallId = State(initialValue: initialCall?.id)
    }

    /// Editable custom fields (filtered + sorted).
    ///
    /// `editableByUsers` is the wire field (`customFieldDefinitionSchema`); a
    /// field an admin marked read-only must not render an input here.
    private var editableFields: [CustomFieldsListResponseField] {
        customFields
            .filter { $0.editableByUsers }
            .sorted { $0.order < $1.order }
    }

    var body: some View {
        NavigationStack {
            Form {
                // Note text section
                Section {
                    TextEditor(text: $noteText)
                        .frame(minHeight: 150)
                        .font(.brand(.body))
                        .foregroundStyle(Color.brandForeground)
                        .scrollContentBackground(.hidden)
                        .padding(8)
                        .background(Color.brandCard)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(noteText.isEmpty ? Color.brandBorder : Color.brandPrimary.opacity(0.5), lineWidth: 1)
                        )
                        .accessibilityIdentifier("note-text-editor")
                } header: {
                    Text(NSLocalizedString("note_create_text_label", comment: "Note"))
                        .font(.brand(.headline))
                        .foregroundStyle(Color.brandForeground)
                } footer: {
                    if noteText.isEmpty {
                        Text(NSLocalizedString("note_create_text_hint", comment: "Write your call notes here..."))
                            .foregroundStyle(Color.brandMutedForeground)
                    }
                }

                // Custom fields section
                if !editableFields.isEmpty {
                    Section {
                        ForEach(editableFields) { field in
                            customFieldInput(for: field)
                        }
                    } header: {
                        Text(NSLocalizedString("note_create_fields_label", comment: "Details"))
                            .font(.brand(.headline))
                            .foregroundStyle(Color.brandForeground)
                    }
                }

                // Transcript attachment section
                if let service = transcriptionService,
                   !service.finalTranscript.isEmpty || !service.liveTranscript.isEmpty {
                    Section {
                        if let transcript = attachedTranscript {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    Image(systemName: "waveform")
                                        .foregroundStyle(Color.brandPrimary)
                                    Text(NSLocalizedString("transcription_transcript_label", comment: "Call Transcript"))
                                        .font(.brand(.subheadline))
                                        .fontWeight(.medium)
                                    Spacer()
                                    Button {
                                        attachedTranscript = nil
                                    } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .foregroundStyle(Color.brandMutedForeground)
                                    }
                                    .accessibilityIdentifier("remove-transcript")
                                }
                                Text(transcript)
                                    .font(.brand(.caption))
                                    .foregroundStyle(Color.brandMutedForeground)
                                    .lineLimit(5)
                            }
                            .accessibilityIdentifier("attached-transcript")
                        } else {
                            Button {
                                let text = service.finalTranscript.isEmpty
                                    ? service.liveTranscript
                                    : service.finalTranscript
                                if !text.isEmpty {
                                    attachedTranscript = text
                                }
                            } label: {
                                Label {
                                    Text(NSLocalizedString("transcription_attach_to_note", comment: "Attach transcript to note"))
                                } icon: {
                                    Image(systemName: "waveform.badge.plus")
                                        .foregroundStyle(Color.brandPrimary)
                                }
                            }
                            .accessibilityIdentifier("attach-transcript")
                        }
                    } header: {
                        Text(NSLocalizedString("transcription_title", comment: "Transcription"))
                            .font(.brand(.headline))
                            .foregroundStyle(Color.brandForeground)
                    }
                }

                // Call section — a note belongs to a call (the server rejects one without)
                Section {
                    ForEach(choices) { call in
                        callChoiceRow(call)
                    }
                    if choices.isEmpty {
                        if isLoadingChoices {
                            ProgressView()
                        } else {
                            Text(NSLocalizedString("call_history_empty_title", comment: "No Call History"))
                                .font(.brand(.footnote))
                                .foregroundStyle(Color.brandMutedForeground)
                                .accessibilityIdentifier("note-call-choices-empty")
                        }
                    }
                    if let choicesError {
                        Text(choicesError)
                            .font(.brand(.footnote))
                            .foregroundStyle(Color.brandMutedForeground)
                            .accessibilityIdentifier("note-call-choices-error")
                    }
                } header: {
                    Text(NSLocalizedString("note_create_call_id_label", comment: "Associated Call"))
                        .font(.brand(.headline))
                        .foregroundStyle(Color.brandForeground)
                }

                // Error display
                if let error = errorMessage {
                    Section {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange)
                            Text(error)
                                .font(.brand(.footnote))
                                .foregroundStyle(Color.brandMutedForeground)
                        }
                    }
                    .accessibilityIdentifier("note-create-error")
                }
            }
            .tint(Color.brandPrimary)
            .navigationTitle(NSLocalizedString("note_create_title", comment: "New Note"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        dismiss()
                    }
                    .disabled(isSaving)
                    .accessibilityIdentifier("cancel-note-create")
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await saveNote() }
                    } label: {
                        Text(NSLocalizedString("note_create_save", comment: "Save"))
                            .font(.brand(.subheadline))
                            .fontWeight(.semibold)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 6)
                            .background(
                                RoundedRectangle(cornerRadius: 14)
                                    .fill(Color.brandPrimary)
                                    .opacity(canSave ? 1.0 : 0.4)
                            )
                    }
                    .disabled(!canSave)
                    .accessibilityIdentifier("save-note")
                }
            }
            .loadingOverlay(
                isPresented: isSaving,
                message: NSLocalizedString("note_create_saving", comment: "Encrypting & saving...")
            )
            .interactiveDismissDisabled(isSaving)
        }
    }

    // MARK: - Call Choice

    private func callChoiceRow(_ call: CallReference) -> some View {
        let isSelected = call.id == selectedCallId
        return Button {
            selectedCallId = call.id
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(call.title)
                        .font(.brand(.body))
                        .foregroundStyle(Color.brandForeground)
                    Text(call.startedAt.formatted(date: .abbreviated, time: .shortened))
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color.brandPrimary)
                }
            }
        }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("note-call-choice-\(call.id)")
    }

    // MARK: - Custom Field Input

    @ViewBuilder
    private func customFieldInput(for field: CustomFieldsListResponseField) -> some View {
        switch field.type {
        case .text:
            TextField(
                field.label,
                text: textBinding(for: field.name)
            )
            .accessibilityIdentifier("field-\(field.name)")

        case .textarea:
            VStack(alignment: .leading, spacing: 4) {
                Text(field.label)
                    .font(.brand(.subheadline))
                    .foregroundStyle(.secondary)
                TextEditor(text: textBinding(for: field.name))
                    .frame(minHeight: 80)
                    .font(.brand(.body))
            }
            .accessibilityIdentifier("field-\(field.name)")

        case .number:
            HStack {
                Text(field.label)
                Spacer()
                TextField(
                    "0",
                    text: numberBinding(for: field.name)
                )
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 80)
            }
            .accessibilityIdentifier("field-\(field.name)")

        case .select:
            Picker(field.label, selection: selectBinding(for: field.name, options: field.options ?? [])) {
                Text(NSLocalizedString("select_placeholder", comment: "Select..."))
                    .tag("")
                if let options = field.options {
                    ForEach(options, id: \.self) { option in
                        Text(option).tag(option)
                    }
                }
            }
            .accessibilityIdentifier("field-\(field.name)")

        case .checkbox:
            Toggle(field.label, isOn: checkboxBinding(for: field.name))
                .accessibilityIdentifier("field-\(field.name)")

        case .file, .location:
            // No inline editor for uploads or map pickers in the note form;
            // these are captured on the record screens.
            EmptyView()
        }

        // Show required indicator
        if field.isRequired {
            if case .none = fieldValues[field.name] {
                Text(NSLocalizedString("field_required", comment: "Required"))
                    .font(.brand(.caption2))
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: - Field Bindings

    private func textBinding(for name: String) -> Binding<String> {
        Binding<String>(
            get: {
                if case .string(let val) = fieldValues[name] {
                    return val
                }
                return ""
            },
            set: { newValue in
                if newValue.isEmpty {
                    fieldValues.removeValue(forKey: name)
                } else {
                    fieldValues[name] = .string(newValue)
                }
            }
        )
    }

    private func numberBinding(for name: String) -> Binding<String> {
        Binding<String>(
            get: {
                if case .int(let val) = fieldValues[name] {
                    return "\(val)"
                }
                return ""
            },
            set: { newValue in
                if let intVal = Int(newValue) {
                    fieldValues[name] = .int(intVal)
                } else if newValue.isEmpty {
                    fieldValues.removeValue(forKey: name)
                }
            }
        )
    }

    private func selectBinding(for name: String, options: [String]) -> Binding<String> {
        Binding<String>(
            get: {
                if case .string(let val) = fieldValues[name] {
                    return val
                }
                return ""
            },
            set: { newValue in
                if newValue.isEmpty {
                    fieldValues.removeValue(forKey: name)
                } else {
                    fieldValues[name] = .string(newValue)
                }
            }
        )
    }

    private func checkboxBinding(for name: String) -> Binding<Bool> {
        Binding<Bool>(
            get: {
                if case .bool(let val) = fieldValues[name] {
                    return val
                }
                return false
            },
            set: { newValue in
                fieldValues[name] = .bool(newValue)
            }
        )
    }

    // MARK: - Save

    private func saveNote() async {
        guard canSave, let call = selectedCall else { return }

        // Validate required fields
        for field in editableFields where field.isRequired {
            if fieldValues[field.name] == nil {
                errorMessage = L10n.format("note_create_field_required", comment: "%@ is required", field.label)
                return
            }
        }

        isSaving = true
        errorMessage = nil

        do {
            let fields = fieldValues.isEmpty ? nil : fieldValues
            try await onSave(trimmedText, fields, call, attachedTranscript)
        } catch {
            errorMessage = error.localizedDescription
            isSaving = false
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Create Note") {
    NoteCreateView(
        customFields: [
            CustomFieldsListResponseField(
                name: "severity", label: "Severity (1-5)", type: .number,
                required: true, order: 0
            ),
            CustomFieldsListResponseField(
                name: "category", label: "Category", type: .select,
                required: false,
                options: ["Legal", "Medical", "Housing", "Financial", "Other"],
                order: 1
            ),
            CustomFieldsListResponseField(
                name: "followUp", label: "Follow-up Needed", type: .checkbox,
                required: false, order: 2
            ),
        ],
        choices: [
            CallReference(id: "call-1", hubId: "hub-1", startedAt: Date(), phase: .ended),
            CallReference(id: "call-2", hubId: "hub-1", startedAt: Date().addingTimeInterval(-3600), phase: .recorded(.answered)),
        ],
        initialCall: CallReference(id: "call-1", hubId: "hub-1", startedAt: Date(), phase: .ended),
        onSave: { _, _, _, _ in }
    )
}
#endif
