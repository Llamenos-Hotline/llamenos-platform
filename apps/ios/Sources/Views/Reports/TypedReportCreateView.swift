import SwiftUI
import UniformTypeIdentifiers

// MARK: - FileAttachment

/// Tracks the state of a file selected for upload in a report form.
struct FileAttachment {
    let fileName: String
    let fileSize: Int
    let mimeType: String
    var isUploading: Bool = false
    var uploadedFileId: String?
    var fileKeyHex: String?
    var error: String?
}

// MARK: - TypedReportCreateView

/// Template-driven report creation form. Renders fields dynamically from a
/// `ClientReportTypeDefinition`. Each field type maps to a native SwiftUI control.
/// Textarea fields with `supportAudioInput: true` show a mic button for
/// speech-to-text dictation.
///
/// Supports:
/// - Conditional field visibility via `showWhen` rules
/// - Field validation constraints (min/max, pattern, length)
/// - Placeholder text from field definitions
/// - Default values from field definitions
struct TypedReportCreateView: View {
    let reportType: ClientReportTypeDefinition
    let onSubmit: (String, [String: AnyCodableValue]) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @Environment(AppState.self) private var appState

    @State private var fieldValues: [String: AnyCodableValue] = [:]
    @State private var multiselectValues: [String: Set<String>] = [:]
    @State private var dateValues: [String: Date] = [:]
    @State private var isSaving: Bool = false
    @State private var errorMessage: String?
    @State private var validationErrors: [String: String] = [:]
    @State private var hasInitializedDefaults: Bool = false
    @State private var fileAttachments: [String: FileAttachment] = [:]
    @State private var activeFileFieldName: String?
    @State private var showFilePicker: Bool = false
    @State private var isUploadingFile: Bool = false

    /// Fields sorted by order, grouped by section.
    private var sortedFields: [ClientReportFieldDefinition] {
        reportType.fields.sorted { $0.order < $1.order }
    }

    /// Visible fields after evaluating `showWhen` conditions against current values.
    private var visibleFields: [ClientReportFieldDefinition] {
        sortedFields.filter { $0.isVisible(given: fieldValues) }
    }

    /// Visible fields grouped by section (nil section = default group).
    private var fieldSections: [(section: String?, fields: [ClientReportFieldDefinition])] {
        let grouped = Dictionary(grouping: visibleFields) { $0.section }
        // Preserve order: nil section first, then named sections in field order
        var result: [(section: String?, fields: [ClientReportFieldDefinition])] = []
        if let defaultFields = grouped[nil], !defaultFields.isEmpty {
            result.append((section: nil, fields: defaultFields))
        }
        let namedSections = grouped.filter { $0.key != nil }
            .sorted { ($0.value.first?.order ?? 0) < ($1.value.first?.order ?? 0) }
        for (section, fields) in namedSections {
            result.append((section: section, fields: fields))
        }
        return result
    }

    var body: some View {
        NavigationStack {
            Form {
                ForEach(Array(fieldSections.enumerated()), id: \.offset) { _, group in
                    Section {
                        ForEach(group.fields) { field in
                            fieldInput(for: field)
                        }
                    } header: {
                        if let section = group.section {
                            Text(section)
                                .font(.brand(.headline))
                                .foregroundStyle(Color.brandForeground)
                        }
                    }
                }

                // Error display
                if let error = errorMessage {
                    Section {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(Color.brandDestructive)
                            Text(error)
                                .font(.brand(.footnote))
                                .foregroundStyle(Color.brandDestructive)
                        }
                    }
                    .accessibilityIdentifier("typed-report-error")
                }
            }
            .tint(Color.brandPrimary)
            .navigationTitle(reportType.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        dismiss()
                    }
                    .disabled(isSaving)
                    .accessibilityIdentifier("cancel-typed-report")
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await submitReport() }
                    } label: {
                        Text(NSLocalizedString("report_submit", comment: "Submit"))
                            .font(.brand(.subheadline))
                            .fontWeight(.semibold)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 6)
                            .background(
                                RoundedRectangle(cornerRadius: 14)
                                    .fill(Color.brandPrimary)
                                    .opacity(isFormValid && !isSaving ? 1.0 : 0.4)
                            )
                    }
                    .disabled(!isFormValid || isSaving)
                    .accessibilityIdentifier("typed-report-submit")
                }
            }
            .loadingOverlay(
                isPresented: isSaving,
                message: NSLocalizedString("report_create_saving", comment: "Encrypting & submitting...")
            )
            .interactiveDismissDisabled(isSaving)
            .fileImporter(
                isPresented: $showFilePicker,
                allowedContentTypes: [.data, .image, .movie, .audio, .pdf],
                allowsMultipleSelection: false
            ) { result in
                handleFileSelection(result)
            }
            .onAppear {
                initializeDefaults()
            }
        }
    }

    // MARK: - Default Value Initialization

    /// Set default values from field definitions on first appearance.
    private func initializeDefaults() {
        guard !hasInitializedDefaults else { return }
        hasInitializedDefaults = true

        for field in sortedFields {
            guard let defaultValue = field.defaultValue else { continue }
            // Only set if the field doesn't already have a value
            guard fieldValues[field.name] == nil else { continue }

            switch (field.fieldType, defaultValue) {
            case (.text, .string(let val)), (.textarea, .string(let val)), (.select, .string(let val)):
                fieldValues[field.name] = .string(val)
            case (.number, .double(let val)):
                fieldValues[field.name] = .int(Int(val))
            case (.checkbox, .bool(let val)):
                fieldValues[field.name] = .bool(val)
            default:
                break
            }
        }
    }

    // MARK: - Validation

    private var isFormValid: Bool {
        for field in visibleFields where field.required {
            switch field.fieldType {
            case .multiselect:
                if multiselectValues[field.name]?.isEmpty ?? true {
                    return false
                }
            case .date:
                if dateValues[field.name] == nil {
                    return false
                }
            default:
                if fieldValues[field.name] == nil {
                    return false
                }
            }
        }
        // Also check that there are no validation errors
        return validationErrors.isEmpty
    }

    /// Validate a field value against its validation constraints.
    /// Returns an error message string if validation fails, nil if valid.
    private func validateField(_ field: ClientReportFieldDefinition, value: AnyCodableValue?) -> String? {
        guard let validation = field.validation else { return nil }

        switch field.fieldType {
        case .text, .textarea:
            if case .string(let str) = value {
                if let minLen = validation.minLength, Double(str.count) < minLen {
                    return L10n.format("field_validation_min_length", comment: "Must be at least %d characters", Int(minLen))
                }
                if let maxLen = validation.maxLength, Double(str.count) > maxLen {
                    return L10n.format("field_validation_max_length", comment: "Must be at most %d characters", Int(maxLen))
                }
                if let pattern = validation.pattern {
                    let regex = try? NSRegularExpression(pattern: pattern)
                    let range = NSRange(str.startIndex..., in: str)
                    if regex?.firstMatch(in: str, range: range) == nil {
                        return NSLocalizedString("field_validation_pattern", comment: "Invalid format")
                    }
                }
            }

        case .number:
            if case .int(let num) = value {
                if let min = validation.min, Double(num) < min {
                    return L10n.format("field_validation_min", comment: "Must be at least %d", Int(min))
                }
                if let max = validation.max, Double(num) > max {
                    return L10n.format("field_validation_max", comment: "Must be at most %d", Int(max))
                }
            }

        default:
            break
        }

        return nil
    }

    /// Run validation for a specific field and update the validation errors map.
    private func runValidation(for field: ClientReportFieldDefinition) {
        let error = validateField(field, value: fieldValues[field.name])
        if let error {
            validationErrors[field.name] = error
        } else {
            validationErrors.removeValue(forKey: field.name)
        }
    }

    // MARK: - Field Rendering

    @ViewBuilder
    private func fieldInput(for field: ClientReportFieldDefinition) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            switch field.fieldType {
            case .text:
                textField(for: field)

            case .textarea:
                textareaField(for: field)

            case .number:
                numberField(for: field)

            case .select:
                selectField(for: field)

            case .multiselect:
                multiselectField(for: field)

            case .checkbox:
                checkboxField(for: field)

            case .date:
                dateField(for: field)

            case .file:
                fileAttachmentField(for: field)
            }

            // Help text
            if let helpText = field.helpText, !helpText.isEmpty {
                Text(helpText)
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
            }

            // Validation error
            if let validationError = validationErrors[field.name] {
                Text(validationError)
                    .font(.brand(.caption2))
                    .foregroundStyle(Color.brandDestructive)
                    .accessibilityIdentifier("field-\(field.name)-validation-error")
            }

            // Required indicator (shown only when no validation error is displayed)
            if field.required, validationErrors[field.name] == nil {
                let hasValue: Bool = {
                    switch field.fieldType {
                    case .multiselect:
                        return !(multiselectValues[field.name]?.isEmpty ?? true)
                    case .date:
                        return dateValues[field.name] != nil
                    default:
                        return fieldValues[field.name] != nil
                    }
                }()
                if !hasValue {
                    Text(NSLocalizedString("field_required", comment: "Required"))
                        .font(.brand(.caption2))
                        .foregroundStyle(Color.brandDestructive)
                }
            }
        }
        .accessibilityIdentifier("field-\(field.name)")
    }

    // MARK: - Text Field

    @ViewBuilder
    private func textField(for field: ClientReportFieldDefinition) -> some View {
        TextField(
            field.placeholder ?? field.label,
            text: validatedTextBinding(for: field)
        )
        .font(.brand(.body))
    }

    // MARK: - Textarea Field

    @ViewBuilder
    private func textareaField(for field: ClientReportFieldDefinition) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(field.label)
                    .font(.brand(.subheadline))
                    .foregroundStyle(.secondary)

                if field.required {
                    Text("*")
                        .foregroundStyle(Color.brandDestructive)
                }

                Spacer()

                // Audio input button for fields that support it
                if field.supportAudioInput {
                    AudioInputButton(text: validatedTextBinding(for: field))
                }
            }

            TextEditor(text: validatedTextBinding(for: field))
                .frame(minHeight: 100)
                .font(.brand(.body))
                .foregroundStyle(Color.brandForeground)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(Color.brandCard)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(
                            validationErrors[field.name] != nil
                                ? Color.brandDestructive.opacity(0.7)
                                : (textBinding(for: field.name).wrappedValue.isEmpty
                                    ? Color.brandBorder
                                    : Color.brandPrimary.opacity(0.5)),
                            lineWidth: 1
                        )
                )

            // Character count for fields with maxLength validation
            if let maxLen = field.validation?.maxLength {
                let currentLen = (textBinding(for: field.name).wrappedValue).count
                HStack {
                    Spacer()
                    Text("\(currentLen)/\(Int(maxLen))")
                        .font(.brand(.caption2))
                        .foregroundStyle(
                            Double(currentLen) > maxLen
                                ? Color.brandDestructive
                                : Color.brandMutedForeground
                        )
                }
            }
        }
    }

    // MARK: - Number Field

    @ViewBuilder
    private func numberField(for field: ClientReportFieldDefinition) -> some View {
        HStack {
            Text(field.label)
                .font(.brand(.body))

            if field.required {
                Text("*")
                    .foregroundStyle(Color.brandDestructive)
            }

            Spacer()

            TextField(
                field.placeholder ?? "0",
                text: validatedNumberBinding(for: field)
            )
            .keyboardType(.numberPad)
            .multilineTextAlignment(.trailing)
            .font(.brand(.body))
            .frame(width: 80)
        }
    }

    // MARK: - Select Field

    @ViewBuilder
    private func selectField(for field: ClientReportFieldDefinition) -> some View {
        Picker(selection: selectBinding(for: field.name)) {
            Text(field.placeholder ?? NSLocalizedString("select_placeholder", comment: "Select..."))
                .tag("")
            if let options = field.options {
                ForEach(options, id: \.key) { option in
                    Text(option.label).tag(option.key)
                }
            }
        } label: {
            HStack(spacing: 2) {
                Text(field.label)
                if field.required {
                    Text("*")
                        .foregroundStyle(Color.brandDestructive)
                }
            }
        }
        .font(.brand(.body))
    }

    // MARK: - Multiselect Field

    @ViewBuilder
    private func multiselectField(for field: ClientReportFieldDefinition) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 2) {
                Text(field.label)
                    .font(.brand(.subheadline))
                    .foregroundStyle(.secondary)
                if field.required {
                    Text("*")
                        .foregroundStyle(Color.brandDestructive)
                }
            }

            if let options = field.options {
                ForEach(options, id: \.key) { option in
                    Toggle(option.label, isOn: multiselectToggleBinding(for: field.name, key: option.key))
                        .font(.brand(.body))
                        .accessibilityIdentifier("field-\(field.name)-\(option.key)")
                }
            }
        }
    }

    // MARK: - Checkbox Field

    @ViewBuilder
    private func checkboxField(for field: ClientReportFieldDefinition) -> some View {
        Toggle(field.label, isOn: checkboxBinding(for: field.name))
            .font(.brand(.body))
    }

    // MARK: - Date Field

    @ViewBuilder
    private func dateField(for field: ClientReportFieldDefinition) -> some View {
        DatePicker(
            selection: dateBinding(for: field.name),
            displayedComponents: [.date, .hourAndMinute]
        ) {
            HStack(spacing: 2) {
                Text(field.label)
                    .font(.brand(.body))
                if field.required {
                    Text("*")
                        .foregroundStyle(Color.brandDestructive)
                }
            }
        }
    }

    // MARK: - File Attachment Field

    @ViewBuilder
    private func fileAttachmentField(for field: ClientReportFieldDefinition) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 2) {
                Text(field.label)
                    .font(.brand(.subheadline))
                    .foregroundStyle(.secondary)
                if field.required {
                    Text("*")
                        .foregroundStyle(Color.brandDestructive)
                }
            }

            if let attachment = fileAttachments[field.name] {
                // Show selected file
                HStack(spacing: 10) {
                    Image(systemName: fileIcon(for: attachment.mimeType))
                        .font(.title3)
                        .foregroundStyle(Color.brandPrimary)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(attachment.fileName)
                            .font(.brand(.subheadline))
                            .lineLimit(1)
                        Text(formatFileSize(attachment.fileSize))
                            .font(.brand(.caption2))
                            .foregroundStyle(.secondary)
                        if attachment.isUploading {
                            HStack(spacing: 4) {
                                ProgressView()
                                    .scaleEffect(0.7)
                                Text(NSLocalizedString("report_file_encrypting", comment: "Encrypting..."))
                                    .font(.brand(.caption2))
                                    .foregroundStyle(.secondary)
                            }
                        } else if let fileId = attachment.uploadedFileId {
                            HStack(spacing: 4) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.caption)
                                    .foregroundStyle(.green)
                                Text(NSLocalizedString("report_file_uploaded", comment: "Encrypted & uploaded"))
                                    .font(.brand(.caption2))
                                    .foregroundStyle(.secondary)
                            }
                            .onAppear {
                                // Store file ID in field values for submission
                                fieldValues[field.name] = .string(fileId)
                            }
                        } else if let error = attachment.error {
                            Text(error)
                                .font(.brand(.caption2))
                                .foregroundStyle(Color.brandDestructive)
                        }
                    }

                    Spacer()

                    // Remove button
                    Button {
                        fileAttachments.removeValue(forKey: field.name)
                        fieldValues.removeValue(forKey: field.name)
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("field-\(field.name)-remove-file")
                }
                .padding(10)
                .background(Color.brandCard)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                // Tap to select file
                Button {
                    activeFileFieldName = field.name
                    showFilePicker = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "paperclip")
                            .font(.body)
                        Text(NSLocalizedString("report_file_select", comment: "Select file..."))
                            .font(.brand(.body))
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .foregroundStyle(Color.brandPrimary)
                    .padding(10)
                    .background(Color.brandCard)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(Color.brandBorder, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("field-\(field.name)-select-file")
            }

            // E2EE note
            HStack(spacing: 4) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 9))
                Text(NSLocalizedString("report_file_e2ee", comment: "Files are encrypted before upload"))
                    .font(.brand(.caption2))
            }
            .foregroundStyle(.secondary)
        }
    }

    private func fileIcon(for mimeType: String) -> String {
        if mimeType.hasPrefix("image/") { return "photo" }
        if mimeType.hasPrefix("video/") { return "video" }
        if mimeType.hasPrefix("audio/") { return "waveform" }
        if mimeType.contains("pdf") { return "doc.richtext" }
        return "doc"
    }

    private func formatFileSize(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return String(format: "%.1f KB", Double(bytes) / 1024.0) }
        return String(format: "%.1f MB", Double(bytes) / (1024.0 * 1024.0))
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

    /// Text binding that also triggers validation on change.
    private func validatedTextBinding(for field: ClientReportFieldDefinition) -> Binding<String> {
        Binding<String>(
            get: {
                if case .string(let val) = fieldValues[field.name] {
                    return val
                }
                return ""
            },
            set: { newValue in
                if newValue.isEmpty {
                    fieldValues.removeValue(forKey: field.name)
                } else {
                    fieldValues[field.name] = .string(newValue)
                }
                runValidation(for: field)
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

    /// Number binding that also triggers validation on change.
    private func validatedNumberBinding(for field: ClientReportFieldDefinition) -> Binding<String> {
        Binding<String>(
            get: {
                if case .int(let val) = fieldValues[field.name] {
                    return "\(val)"
                }
                return ""
            },
            set: { newValue in
                if let intVal = Int(newValue) {
                    fieldValues[field.name] = .int(intVal)
                } else if newValue.isEmpty {
                    fieldValues.removeValue(forKey: field.name)
                }
                runValidation(for: field)
            }
        )
    }

    private func selectBinding(for name: String) -> Binding<String> {
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

    private func multiselectToggleBinding(for name: String, key: String) -> Binding<Bool> {
        Binding<Bool>(
            get: {
                multiselectValues[name]?.contains(key) ?? false
            },
            set: { isOn in
                var current = multiselectValues[name] ?? Set<String>()
                if isOn {
                    current.insert(key)
                } else {
                    current.remove(key)
                }
                multiselectValues[name] = current

                // Sync to fieldValues as comma-separated string
                if current.isEmpty {
                    fieldValues.removeValue(forKey: name)
                } else {
                    fieldValues[name] = .string(current.sorted().joined(separator: ","))
                }
            }
        )
    }

    private func dateBinding(for name: String) -> Binding<Date> {
        Binding<Date>(
            get: {
                dateValues[name] ?? Date()
            },
            set: { newValue in
                dateValues[name] = newValue
                // Store as ISO 8601 string
                let formatter = ISO8601DateFormatter()
                fieldValues[name] = .string(formatter.string(from: newValue))
            }
        )
    }

    // MARK: - File Handling

    private func handleFileSelection(_ result: Result<[URL], Error>) {
        guard let fieldName = activeFileFieldName else { return }
        activeFileFieldName = nil

        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }

            // Start accessing security-scoped resource
            guard url.startAccessingSecurityScopedResource() else {
                fileAttachments[fieldName] = FileAttachment(
                    fileName: url.lastPathComponent,
                    fileSize: 0,
                    mimeType: "application/octet-stream",
                    error: NSLocalizedString("report_file_access_denied", comment: "Cannot access this file")
                )
                return
            }
            defer { url.stopAccessingSecurityScopedResource() }

            do {
                let data = try Data(contentsOf: url)
                let mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                let fileName = url.lastPathComponent

                fileAttachments[fieldName] = FileAttachment(
                    fileName: fileName,
                    fileSize: data.count,
                    mimeType: mimeType,
                    isUploading: true
                )

                // Upload in background
                Task {
                    await uploadEncryptedFile(fieldName: fieldName, data: data, fileName: fileName, mimeType: mimeType)
                }
            } catch {
                fileAttachments[fieldName] = FileAttachment(
                    fileName: url.lastPathComponent,
                    fileSize: 0,
                    mimeType: "application/octet-stream",
                    error: error.localizedDescription
                )
            }

        case .failure(let error):
            fileAttachments[fieldName] = FileAttachment(
                fileName: "",
                fileSize: 0,
                mimeType: "application/octet-stream",
                error: error.localizedDescription
            )
        }
    }

    @MainActor
    private func uploadEncryptedFile(fieldName: String, data: Data, fileName: String, mimeType: String) async {
        do {
            // Encrypt the file content with a random AES-256-GCM key
            let plaintextHex = data.map { String(format: "%02x", $0) }.joined()
            let (ciphertextHex, fileKeyHex) = try appState.cryptoService.symmetricEncrypt(plaintextHex: plaintextHex)

            // Convert ciphertext hex back to Data for upload
            let encryptedData = hexToData(ciphertextHex)

            // Upload encrypted data
            let response = try await appState.apiService.uploadEntityFile(
                encryptedData: encryptedData,
                fileName: fileName
            )

            fileAttachments[fieldName]?.uploadedFileId = response.fileId
            fileAttachments[fieldName]?.fileKeyHex = fileKeyHex
            fileAttachments[fieldName]?.isUploading = false

        } catch {
            fileAttachments[fieldName]?.error = error.localizedDescription
            fileAttachments[fieldName]?.isUploading = false
        }
    }

    private func hexToData(_ hex: String) -> Data {
        var data = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let nextIndex = hex.index(index, offsetBy: 2)
            if let byte = UInt8(hex[index..<nextIndex], radix: 16) {
                data.append(byte)
            }
            index = nextIndex
        }
        return data
    }

    // MARK: - Submit

    private func submitReport() async {
        // Validate all visible required fields
        for field in visibleFields where field.required {
            let hasValue: Bool
            switch field.fieldType {
            case .multiselect:
                hasValue = !(multiselectValues[field.name]?.isEmpty ?? true)
            case .date:
                hasValue = dateValues[field.name] != nil
            default:
                hasValue = fieldValues[field.name] != nil
            }

            if !hasValue {
                errorMessage = L10n.format("note_create_field_required", comment: "%@ is required", field.label)
                return
            }
        }

        // Run validation on all visible fields before submit
        for field in visibleFields {
            runValidation(for: field)
        }
        guard validationErrors.isEmpty else {
            errorMessage = NSLocalizedString("report_validation_errors", comment: "Please fix the errors above before submitting.")
            return
        }

        isSaving = true
        errorMessage = nil

        // Derive title from first text/textarea field or report type label
        let title = deriveTitle()

        let success = await onSubmit(title, fieldValues)

        if success {
            dismiss()
        } else {
            isSaving = false
        }
    }

    /// Derive a title from the first text or textarea field value, or fall back to
    /// the report type label with a timestamp.
    private func deriveTitle() -> String {
        // Try first text/textarea field as title
        for field in sortedFields {
            if field.fieldType == .text || field.fieldType == .textarea {
                if case .string(let val) = fieldValues[field.name], !val.isEmpty {
                    let trimmed = val.trimmingCharacters(in: .whitespacesAndNewlines)
                    // Use first 100 chars as title
                    if trimmed.count > 100 {
                        return String(trimmed.prefix(100))
                    }
                    return trimmed
                }
            }
        }

        // Fallback: report type label + date
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return "\(reportType.label) - \(formatter.string(from: Date()))"
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Typed Report Form") {
    TypedReportCreateView(
        reportType: ClientReportTypeDefinition(
            id: "1", name: "arrest_report", label: "Arrest Report",
            labelPlural: "Arrest Reports",
            description: "Document an arrest observed in the field",
            icon: "exclamationmark.shield.fill", color: "#E74C3C",
            category: "report",
            fields: [
                ClientReportFieldDefinition(
                    id: "f1", name: "location", label: "Location",
                    type: "text", required: true, options: nil,
                    section: nil, helpText: "Street address or intersection",
                    order: 0, accessLevel: "all", supportAudioInput: false,
                    placeholder: "123 Main St", defaultValue: nil,
                    validation: nil, showWhen: nil, indexable: nil,
                    indexType: nil, hubEditable: nil, editableByVolunteers: nil,
                    visibleToVolunteers: nil, accessRoles: nil, templateId: nil,
                    lookupId: nil
                ),
                ClientReportFieldDefinition(
                    id: "f2", name: "description", label: "Description",
                    type: "textarea", required: true, options: nil,
                    section: nil, helpText: "Describe what you observed",
                    order: 1, accessLevel: "all", supportAudioInput: true,
                    placeholder: nil, defaultValue: nil,
                    validation: FieldValidation(min: nil, max: nil, minLength: 10, maxLength: 2000, pattern: nil),
                    showWhen: nil, indexable: nil, indexType: nil,
                    hubEditable: nil, editableByVolunteers: nil,
                    visibleToVolunteers: nil, accessRoles: nil, templateId: nil,
                    lookupId: nil
                ),
                ClientReportFieldDefinition(
                    id: "f3", name: "num_arrested", label: "Number Arrested",
                    type: "number", required: false, options: nil,
                    section: "Details", helpText: nil,
                    order: 2, accessLevel: "all", supportAudioInput: false,
                    placeholder: nil, defaultValue: nil,
                    validation: FieldValidation(min: 0, max: 1000, minLength: nil, maxLength: nil, pattern: nil),
                    showWhen: nil, indexable: nil, indexType: nil,
                    hubEditable: nil, editableByVolunteers: nil,
                    visibleToVolunteers: nil, accessRoles: nil, templateId: nil,
                    lookupId: nil
                ),
                ClientReportFieldDefinition(
                    id: "f4", name: "arrest_type", label: "Arrest Type",
                    type: "select", required: true,
                    options: [
                        FieldOption(key: "mass", label: "Mass Arrest"),
                        FieldOption(key: "targeted", label: "Targeted"),
                        FieldOption(key: "unknown", label: "Unknown"),
                    ],
                    section: "Details", helpText: nil,
                    order: 3, accessLevel: "all", supportAudioInput: false,
                    placeholder: nil, defaultValue: nil, validation: nil,
                    showWhen: nil, indexable: nil, indexType: nil,
                    hubEditable: nil, editableByVolunteers: nil,
                    visibleToVolunteers: nil, accessRoles: nil, templateId: nil,
                    lookupId: nil
                ),
                ClientReportFieldDefinition(
                    id: "f5", name: "force_used", label: "Force Used",
                    type: "checkbox", required: false, options: nil,
                    section: "Details", helpText: nil,
                    order: 4, accessLevel: "all", supportAudioInput: false,
                    placeholder: nil, defaultValue: nil, validation: nil,
                    showWhen: nil, indexable: nil, indexType: nil,
                    hubEditable: nil, editableByVolunteers: nil,
                    visibleToVolunteers: nil, accessRoles: nil, templateId: nil,
                    lookupId: nil
                ),
                ClientReportFieldDefinition(
                    id: "f6", name: "force_type", label: "Type of Force",
                    type: "select", required: false,
                    options: [
                        FieldOption(key: "physical", label: "Physical"),
                        FieldOption(key: "chemical", label: "Chemical (pepper spray, tear gas)"),
                        FieldOption(key: "taser", label: "Taser/ECD"),
                        FieldOption(key: "firearm", label: "Firearm"),
                    ],
                    section: "Details", helpText: nil,
                    order: 5, accessLevel: "all", supportAudioInput: false,
                    placeholder: nil, defaultValue: nil, validation: nil,
                    showWhen: FieldShowWhen(field: "force_used", operator: "equals", value: .bool(true)),
                    indexable: nil, indexType: nil,
                    hubEditable: nil, editableByVolunteers: nil,
                    visibleToVolunteers: nil, accessRoles: nil, templateId: nil,
                    lookupId: nil
                ),
                ClientReportFieldDefinition(
                    id: "f7", name: "charges", label: "Charges",
                    type: "multiselect", required: false,
                    options: [
                        FieldOption(key: "trespass", label: "Trespass"),
                        FieldOption(key: "disorderly", label: "Disorderly Conduct"),
                        FieldOption(key: "resisting", label: "Resisting Arrest"),
                        FieldOption(key: "other", label: "Other"),
                    ],
                    section: "Details", helpText: nil,
                    order: 6, accessLevel: "all", supportAudioInput: false,
                    placeholder: nil, defaultValue: nil, validation: nil,
                    showWhen: nil, indexable: nil, indexType: nil,
                    hubEditable: nil, editableByVolunteers: nil,
                    visibleToVolunteers: nil, accessRoles: nil, templateId: nil,
                    lookupId: nil
                ),
                ClientReportFieldDefinition(
                    id: "f8", name: "arrest_time", label: "Time of Arrest",
                    type: "date", required: false, options: nil,
                    section: "Details", helpText: nil,
                    order: 7, accessLevel: "all", supportAudioInput: false,
                    placeholder: nil, defaultValue: nil, validation: nil,
                    showWhen: nil, indexable: nil, indexType: nil,
                    hubEditable: nil, editableByVolunteers: nil,
                    visibleToVolunteers: nil, accessRoles: nil, templateId: nil,
                    lookupId: nil
                ),
            ],
            statuses: [StatusOption(value: "open", label: "Open", color: nil, icon: nil, order: 0, isDefault: true, isClosed: nil, isDeprecated: nil)],
            defaultStatus: "open",
            allowFileAttachments: true, allowCaseConversion: true,
            mobileOptimized: true, isArchived: false,
            hubId: nil, isSystem: nil, numberingEnabled: nil, numberPrefix: nil,
            templateId: nil, templateVersion: nil, closedStatuses: nil,
            createdAt: nil, updatedAt: nil
        ),
        onSubmit: { _, _ in true }
    )
}
#endif
