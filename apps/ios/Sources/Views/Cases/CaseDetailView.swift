import SwiftUI

// MARK: - CaseDetailView

/// Detail view for a single case record with tabs for Details, Timeline, Contacts, Evidence.
/// Shows decrypted summary header, status pill, severity badge, assignment controls,
/// and inline comment input for the timeline.
struct CaseDetailView: View {
    let record: CaseRecord
    let entityType: CaseEntityTypeDefinition
    let viewModel: CaseManagementViewModel
    let appState: AppState

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Header
                caseHeader

                // Tab bar
                tabBar

                // Tab content
                TabView(selection: Binding(
                    get: { viewModel.activeTab },
                    set: { viewModel.activeTab = $0 }
                )) {
                    detailsTab.tag(DetailTab.details)
                    timelineTab.tag(DetailTab.timeline)
                    contactsTab.tag(DetailTab.contacts)
                    evidenceTab.tag(DetailTab.evidence)
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityIdentifier("case-detail-close")
                }
            }
            .task {
                // Load timeline on appear
                await viewModel.loadInteractions(for: record.id)
            }
        }
    }

    // MARK: - Header

    private var caseHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Top row: case number + title + assignment
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    // Case number
                    Text(record.caseNumber ?? String(record.id.prefix(8)))
                        .font(.brand(.title3))
                        .fontWeight(.bold)
                        .fontDesign(.monospaced)

                    // Decrypted title
                    if let summary = viewModel.decryptedSummaries[record.id] {
                        if let title = summary.title {
                            Text(title)
                                .font(.brand(.headline))
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                                .accessibilityIdentifier("case-detail-title")
                        }
                        if let description = summary.description {
                            Text(description)
                                .font(.brand(.caption))
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                                .accessibilityIdentifier("case-detail-description")
                        }
                    }
                }

                Spacer()

                // Assignment buttons
                assignmentButtons
            }

            // Badge row: status + entity type + severity
            HStack(spacing: 8) {
                // Status pill
                statusPill

                // Entity type badge
                Text(entityType.label)
                    .font(.brand(.caption2))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Color.brandMuted)
                    .clipShape(Capsule())

                // Severity badge
                if let sevHash = record.severityHash,
                   let sev = entityType.severities?.first(where: { $0.value == sevHash }) {
                    HStack(spacing: 3) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 9))
                        Text(sev.label)
                    }
                    .font(.brand(.caption2))
                    .foregroundStyle((Color(hex: sev.color ?? "#6b7280") ?? .gray))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background((Color(hex: sev.color ?? "#6b7280") ?? .gray).opacity(0.1))
                    .clipShape(Capsule())
                }
            }

            // Metadata: created, assigned count
            HStack(spacing: 8) {
                Text(NSLocalizedString("cases_created", comment: "Created") + " " + relativeTime(record.createdAt))
                    .font(.brand(.caption2))
                    .foregroundStyle(.secondary)

                if !record.assignedTo.isEmpty {
                    Text("\u{00B7}")
                        .foregroundStyle(.secondary)
                    HStack(spacing: 2) {
                        Image(systemName: "person.2")
                            .font(.system(size: 9))
                        Text("\(record.assignedTo.count) \(NSLocalizedString("cases_assigned_suffix", comment: "assigned"))")
                    }
                    .font(.brand(.caption2))
                    .foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .background(Color.brandCard)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("case-detail-header")
    }

    // MARK: - Assignment Buttons

    private var assignmentButtons: some View {
        VStack(spacing: 4) {
            let isAssigned = appState.cryptoService.pubkey.map { record.assignedTo.contains($0) } ?? false

            if !isAssigned {
                Button {
                    Task { await viewModel.assignToMe(recordId: record.id) }
                } label: {
                    Label(
                        NSLocalizedString("cases_assign_to_me", comment: "Assign to me"),
                        systemImage: "person.badge.plus"
                    )
                    .font(.brand(.caption))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityIdentifier("case-assign-btn")
            } else {
                Button {
                    Task { await viewModel.unassignFromMe(recordId: record.id) }
                } label: {
                    Label(
                        NSLocalizedString("cases_unassign", comment: "Unassign"),
                        systemImage: "person.badge.minus"
                    )
                    .font(.brand(.caption))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.secondary)
                .accessibilityIdentifier("case-unassign-btn")
            }
        }
    }

    // MARK: - Status Pill

    private var statusPill: some View {
        let statusDef = entityType.statuses.first { $0.value == record.statusHash }
        let canEdit = appState.hasPermission("cases:update")

        return Button {
            if canEdit {
                viewModel.showStatusSheet = true
            }
        } label: {
            HStack(spacing: 4) {
                Circle()
                    .fill((Color(hex: statusDef?.color ?? "#6b7280") ?? .gray))
                    .frame(width: 6, height: 6)
                Text(statusDef?.label ?? record.statusHash)
                    .font(.brand(.caption))
                    .fontWeight(.medium)
                if canEdit {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8))
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background((Color(hex: statusDef?.color ?? "#6b7280") ?? .gray).opacity(0.12))
            .clipShape(Capsule())
        }
        .disabled(!canEdit)
        .accessibilityIdentifier("case-status-pill")
        .sheet(isPresented: Binding(
            get: { viewModel.showStatusSheet },
            set: { viewModel.showStatusSheet = $0 }
        )) {
            QuickStatusSheet(
                currentStatus: record.statusHash,
                statuses: entityType.statuses,
                onSelect: { newStatus in
                    Task {
                        await viewModel.updateStatus(recordId: record.id, newStatus: newStatus)
                        viewModel.showStatusSheet = false
                    }
                }
            )
            .presentationDetents([.medium])
        }
    }

    // MARK: - Tab Bar

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(DetailTab.allCases, id: \.self) { tab in
                tabButton(for: tab)
            }
        }
        // A plain stack is not an accessibility element, so SwiftUI pushed this
        // identifier down onto every child, overwriting theirs (each tab button
        // reported "case-tabs"). As a container it keeps its children's own.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("case-tabs")
    }

    private func tabButton(for tab: DetailTab) -> some View {
        let isActive = viewModel.activeTab == tab
        return Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                viewModel.activeTab = tab
            }
            Task { await loadTabData(tab) }
        } label: {
            VStack(spacing: 4) {
                HStack(spacing: 3) {
                    Image(systemName: tabIcon(tab))
                        .font(.system(size: 14))
                    // Show count badges for contacts and evidence
                    if tab == .contacts, let count = record.contactCount, count > 0 {
                        Text("\(count)")
                            .font(.system(size: 9, weight: .medium))
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color.brandMuted)
                            .clipShape(Capsule())
                    }
                    if tab == .evidence, let count = record.fileCount, count > 0 {
                        Text("\(count)")
                            .font(.system(size: 9, weight: .medium))
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color.brandMuted)
                            .clipShape(Capsule())
                    }
                }
                Text(tab.rawValue)
                    .font(.brand(.caption2))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(isActive ? Color.brandPrimary.opacity(0.1) : Color.clear)
            .overlay(alignment: .bottom) {
                if isActive {
                    Rectangle()
                        .fill(Color.brandPrimary)
                        .frame(height: 2)
                }
            }
        }
        .foregroundStyle(isActive ? Color.brandPrimary : Color.secondary)
        .accessibilityIdentifier("case-tab-\(tab.rawValue.lowercased())")
    }

    private func loadTabData(_ tab: DetailTab) async {
        switch tab {
        case .timeline: await viewModel.loadInteractions(for: record.id)
        case .contacts: await viewModel.loadContacts(for: record.id)
        case .evidence: await viewModel.loadEvidence(for: record.id)
        case .details: break
        }
    }

    private func tabIcon(_ tab: DetailTab) -> String {
        switch tab {
        case .details: return "doc.text"
        case .timeline: return "clock"
        case .contacts: return "person.2"
        case .evidence: return "paperclip"
        }
    }

    // MARK: - Details Tab

    private var detailsTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if viewModel.isDecryptingFields {
                    HStack {
                        ProgressView()
                            .controlSize(.small)
                        Text(NSLocalizedString("cases_decrypting", comment: "Decrypting fields..."))
                            .font(.brand(.caption))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 8)
                }

                // Render fields grouped by section
                let sortedFields = entityType.fields.sorted { ($0.order ?? 0) < ($1.order ?? 0) }
                let sections = Dictionary(grouping: sortedFields) { $0.section ?? "" }
                let sectionKeys = sections.keys.sorted()

                ForEach(sectionKeys, id: \.self) { section in
                    if !section.isEmpty {
                        Text(section)
                            .font(.brand(.headline))
                            .padding(.top, 8)
                            .accessibilityIdentifier("case-section-\(section.lowercased())")
                    }

                    if let fields = sections[section] {
                        ForEach(fields) { field in
                            fieldRow(field)
                        }
                    }
                }

                // Metadata
                VStack(alignment: .leading, spacing: 8) {
                    Text(NSLocalizedString("cases_metadata", comment: "Record Info"))
                        .font(.brand(.headline))
                        .padding(.top, 8)

                    metadataRow(
                        label: NSLocalizedString("cases_created", comment: "Created"),
                        value: formatDate(record.createdAt)
                    )
                    metadataRow(
                        label: NSLocalizedString("cases_updated", comment: "Updated"),
                        value: formatDate(record.updatedAt)
                    )
                    if let closedAt = record.closedAt {
                        metadataRow(
                            label: NSLocalizedString("cases_closed", comment: "Closed"),
                            value: formatDate(closedAt)
                        )
                    }
                    if !record.assignedTo.isEmpty {
                        metadataRow(
                            label: NSLocalizedString("cases_assigned", comment: "Assigned"),
                            value: "\(record.assignedTo.count) volunteer(s)"
                        )
                        // Show truncated pubkeys of assigned volunteers
                        ForEach(record.assignedTo, id: \.self) { pubkey in
                            HStack(spacing: 4) {
                                Image(systemName: "person.circle")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                                Text(String(pubkey.prefix(12)) + "...")
                                    .font(.brand(.caption2))
                                    .foregroundStyle(.secondary)
                                    .fontDesign(.monospaced)
                            }
                            .padding(.leading, 84)
                        }
                    }
                }
            }
            .padding()
        }
        .accessibilityIdentifier("case-details-tab")
    }

    private func fieldRow(_ field: CaseFieldDefinition) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(field.label)
                    .font(.brand(.caption))
                    .foregroundStyle(.secondary)
                if field.accessLevel != nil && field.accessLevel != "all" {
                    Image(systemName: "lock")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
            }

            // Show decrypted value if available, otherwise encrypted placeholder
            if let value = viewModel.decryptedFieldValues[field.name], !value.isEmpty {
                fieldValueView(value: value, field: field)
            } else if viewModel.isDecryptingFields {
                ProgressView()
                    .controlSize(.small)
            } else if record.encryptedFields != nil {
                HStack(spacing: 4) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 9))
                    Text(NSLocalizedString("cases_field_encrypted", comment: "Encrypted"))
                }
                .font(.brand(.caption2))
                .foregroundStyle(.secondary)
            } else {
                Text("\u{2014}")
                    .font(.brand(.body))
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("case-field-\(field.name)")
    }

    @ViewBuilder
    private func fieldValueView(value: String, field: CaseFieldDefinition) -> some View {
        switch field.fieldType {
        case .checkbox:
            HStack(spacing: 4) {
                Image(systemName: value == "Yes" || value == "true" ? "checkmark.square.fill" : "square")
                    .foregroundStyle(value == "Yes" || value == "true" ? Color.brandPrimary : Color.secondary)
                Text(value)
            }
            .font(.brand(.body))

        case .textarea:
            Text(value)
                .font(.brand(.body))
                .lineLimit(5)

        default:
            Text(value)
                .font(.brand(.body))
        }
    }

    private func metadataRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.brand(.caption))
                .foregroundStyle(.secondary)
                .frame(width: 80, alignment: .leading)
            Text(value)
                .font(.brand(.caption))
        }
    }

    private func formatDate(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else {
            return iso
        }
        let display = DateFormatter()
        display.dateStyle = .medium
        display.timeStyle = .short
        return display.string(from: date)
    }

    private func relativeTime(_ iso: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else {
            return ""
        }
        let rel = RelativeDateTimeFormatter()
        rel.unitsStyle = .abbreviated
        return rel.localizedString(for: date, relativeTo: Date())
    }

    // MARK: - Timeline Tab

    private var timelineTab: some View {
        VStack(spacing: 0) {
            // Sort toggle header
            if !viewModel.interactions.isEmpty {
                HStack {
                    Text(NSLocalizedString("timeline_title", comment: "Timeline"))
                        .font(.brand(.caption))
                        .fontWeight(.medium)
                        .foregroundStyle(.secondary)

                    Spacer()

                    Button {
                        viewModel.toggleTimelineSort()
                    } label: {
                        HStack(spacing: 3) {
                            Image(systemName: viewModel.timelineSortNewestFirst ? "arrow.down" : "arrow.up")
                                .font(.system(size: 10))
                            Text(viewModel.timelineSortNewestFirst
                                 ? NSLocalizedString("cases_newest_first", comment: "Newest first")
                                 : NSLocalizedString("cases_oldest_first", comment: "Oldest first"))
                                .font(.brand(.caption2))
                        }
                    }
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("timeline-sort-toggle")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }

            if viewModel.isLoadingInteractions {
                Spacer()
                ProgressView()
                    .padding()
                    .accessibilityIdentifier("timeline-loading")
                Spacer()
            } else if viewModel.interactions.isEmpty {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "clock")
                        .font(.system(size: 30))
                        .foregroundStyle(.secondary)
                    Text(NSLocalizedString("cases_no_interactions", comment: "No activity yet"))
                        .font(.brand(.body))
                        .foregroundStyle(.secondary)
                    Text(NSLocalizedString("cases_no_interactions_hint", comment: "Comments and status changes will appear here."))
                        .font(.brand(.caption2))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("timeline-empty")
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(viewModel.sortedInteractions, id: \.id) { interaction in
                            TimelineItemRow(
                                interaction: interaction,
                                entityType: entityType,
                                cryptoService: appState.cryptoService
                            )
                            .accessibilityIdentifier("timeline-item-\(interaction.id)")
                        }
                    }
                    .padding()
                }
                .accessibilityIdentifier("case-timeline")
            }

            // Comment input bar
            commentInputBar
        }
        .accessibilityIdentifier("case-timeline-tab")
    }

    @State private var inlineCommentText: String = ""

    private var commentInputBar: some View {
        VStack(spacing: 4) {
            Divider()

            HStack(spacing: 8) {
                TextField(
                    NSLocalizedString("cases_comment_placeholder", comment: "Add a comment..."),
                    text: $inlineCommentText,
                    axis: .vertical
                )
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...3)
                .accessibilityIdentifier("case-comment-input")

                if !inlineCommentText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button {
                        let text = inlineCommentText.trimmingCharacters(in: .whitespacesAndNewlines)
                        inlineCommentText = ""
                        Task {
                            await viewModel.addComment(recordId: record.id, text: text)
                        }
                    } label: {
                        Image(systemName: "paperplane.fill")
                            .font(.brand(.body))
                            .foregroundStyle(Color.brandPrimary)
                    }
                    .disabled(viewModel.isActionInProgress)
                    .accessibilityIdentifier("case-comment-submit")
                } else {
                    // Full comment sheet for longer input
                    Button {
                        viewModel.showCommentSheet = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                            .font(.brand(.body))
                    }
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("case-comment-expand")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            // E2EE indicator
            HStack(spacing: 3) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 8))
                Text(NSLocalizedString("cases_comment_encrypted", comment: "Comments are encrypted end-to-end"))
                    .font(.system(size: 9))
            }
            .foregroundStyle(.secondary)
            .padding(.bottom, 4)
        }
        .background(Color.brandCard)
        .sheet(isPresented: Binding(
            get: { viewModel.showCommentSheet },
            set: { viewModel.showCommentSheet = $0 }
        )) {
            AddCommentSheet(
                onSubmit: { text in
                    Task {
                        await viewModel.addComment(recordId: record.id, text: text)
                        viewModel.showCommentSheet = false
                    }
                }
            )
            .presentationDetents([.medium])
        }
    }

    // MARK: - Contacts Tab

    private var contactsTab: some View {
        Group {
            if viewModel.isLoadingContacts {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("case-contacts-loading")
            } else if viewModel.contacts.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "person.2.slash")
                        .font(.system(size: 30))
                        .foregroundStyle(.secondary)
                    Text(NSLocalizedString("cases_no_contacts", comment: "No contacts linked to this case"))
                        .font(.brand(.body))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("case-contacts-empty")
            } else {
                List(viewModel.contacts) { contact in
                    HStack {
                        Image(systemName: "person.circle")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                        VStack(alignment: .leading) {
                            Text(String(contact.contactId.prefix(12)) + "...")
                                .font(.brand(.body))
                                .fontDesign(.monospaced)
                            Text(NSLocalizedString("cases_added", comment: "Added") + " " + relativeTime(contact.addedAt))
                                .font(.brand(.caption2))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        // Role badge with color from entity type contactRoles
                        let roleDef = entityType.contactRoles?.first { $0.value == contact.role }
                        Text(roleDef?.label ?? contact.role)
                            .font(.brand(.caption2))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .foregroundStyle(roleDef?.color.flatMap { Color(hex: $0) } ?? .primary)
                            .background((roleDef?.color.flatMap { Color(hex: $0) } ?? Color.brandMuted).opacity(0.12))
                            .clipShape(Capsule())
                            .accessibilityIdentifier("contact-role-badge")
                    }
                    .accessibilityIdentifier("case-contact-card")
                }
                .listStyle(.plain)
            }
        }
        .accessibilityIdentifier("case-contacts-tab")
    }

    // MARK: - Evidence Tab

    private var evidenceTab: some View {
        Group {
            if viewModel.isLoadingEvidence {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("case-evidence-loading")
            } else if viewModel.evidence.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "doc.text.magnifyingglass")
                        .font(.system(size: 30))
                        .foregroundStyle(.secondary)
                    Text(NSLocalizedString("cases_no_evidence", comment: "No evidence uploaded yet"))
                        .font(.brand(.body))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("case-evidence-empty")
            } else {
                List(viewModel.evidence, id: \.id) { item in
                    HStack {
                        Image(systemName: evidenceIcon(item.mimeType))
                            .font(.title3)
                            .foregroundStyle(evidenceColor(item.classification))
                        VStack(alignment: .leading) {
                            Text(item.filename)
                                .font(.brand(.body))
                                .lineLimit(1)
                            HStack(spacing: 8) {
                                Text(item.classification.rawValue.capitalized)
                                    .font(.brand(.caption2))
                                    .foregroundStyle(.secondary)
                                if item.sizeBytes > 0 {
                                    Text(formatBytes(Int(item.sizeBytes)))
                                        .font(.brand(.caption2))
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(item.classification.rawValue.capitalized)
                                .font(.brand(.caption2))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(Color.brandMuted)
                                .clipShape(Capsule())
                                .accessibilityIdentifier("evidence-classification-badge")
                            if Int(item.custodyEntryCount) > 0 {
                                HStack(spacing: 2) {
                                    Image(systemName: "link")
                                        .font(.system(size: 8))
                                    Text("\(Int(item.custodyEntryCount))")
                                        .font(.brand(.caption2))
                                }
                                .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityIdentifier("evidence-item-\(item.id)")
                }
                .listStyle(.plain)
            }
        }
        .accessibilityIdentifier("case-evidence-tab")
    }

    private func evidenceIcon(_ mimeType: String) -> String {
        if mimeType.starts(with: "image/") { return "photo" }
        if mimeType.starts(with: "video/") { return "film" }
        if mimeType.starts(with: "audio/") { return "waveform" }
        if mimeType.contains("pdf") { return "doc.richtext" }
        return "doc"
    }

    private func evidenceColor(_ classification: SharedClassification) -> Color {
        switch classification {
        case .photo: return .blue
        case .video: return .purple
        case .audio: return .orange
        case .document: return .green
        case .other: return .gray
        }
    }

    private func formatBytes(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}

// MARK: - TimelineItemRow

private struct TimelineItemRow: View {
    let interaction: Interaction
    let entityType: CaseEntityTypeDefinition
    let cryptoService: CryptoService

    @State private var decryptedContent: String?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            // Type icon
            Image(systemName: typeIcon)
                .font(.system(size: 14))
                .foregroundStyle(typeColor)
                .frame(width: 28, height: 28)
                .background(typeColor.opacity(0.12))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(typeLabel)
                        .font(.brand(.caption))
                        .fontWeight(.medium)
                        .accessibilityIdentifier("timeline-item-type")

                    Spacer()

                    Text(relativeTime)
                        .font(.brand(.caption2))
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("timeline-item-time")
                }

                Text(String(interaction.authorPubkey.prefix(12)) + "...")
                    .font(.brand(.caption2))
                    .foregroundStyle(.secondary)
                    .fontDesign(.monospaced)
                    .accessibilityIdentifier("timeline-item-author")

                // Content preview for comments
                if let content = decryptedContent {
                    Text(content)
                        .font(.brand(.body))
                        .lineLimit(4)
                        .padding(.top, 2)
                        .accessibilityIdentifier("timeline-item-content")
                } else if interaction.interactionType == .comment && interaction.encryptedContent != nil {
                    HStack(spacing: 3) {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 9))
                        Text(NSLocalizedString("cases_encrypted_content", comment: "Encrypted content"))
                    }
                    .font(.brand(.caption2))
                    .foregroundStyle(.secondary)
                }

                // Status change details
                if interaction.interactionType == .statusChange,
                   let newHash = interaction.newStatusHash,
                   let newStatus = entityType.statuses.first(where: { $0.value == newHash }) {
                    HStack(spacing: 4) {
                        if let prevHash = interaction.previousStatusHash,
                           let prevStatus = entityType.statuses.first(where: { $0.value == prevHash }) {
                            HStack(spacing: 3) {
                                Circle()
                                    .fill((Color(hex: prevStatus.color ?? "#6b7280") ?? .gray))
                                    .frame(width: 6, height: 6)
                                Text(prevStatus.label)
                                    .font(.brand(.caption2))
                            }
                        }
                        Image(systemName: "arrow.right")
                            .font(.system(size: 9))
                        HStack(spacing: 3) {
                            Circle()
                                .fill((Color(hex: newStatus.color ?? "#6b7280") ?? .gray))
                                .frame(width: 6, height: 6)
                            Text(newStatus.label)
                                .font(.brand(.caption2))
                        }
                    }
                    .foregroundStyle(.secondary)
                }
            }
        }
        .padding(10)
        .background(Color.brandCard)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.brandBorder, lineWidth: 0.5)
        )
        .task {
            await decryptInteractionContent()
        }
    }

    // MARK: - Decrypt Content

    private func decryptInteractionContent() async {
        guard interaction.interactionType == .comment,
              let encrypted = interaction.encryptedContent,
              let envelopes = interaction.contentEnvelopes,
              !envelopes.isEmpty,
              cryptoService.isUnlocked,
              let ourPubkey = cryptoService.pubkey else { return }

        guard let envelope = envelopes.first(where: { $0.pubkey == ourPubkey }) else { return }

        do {
            let hpkeEnvelope = HpkeEnvelope(
                v: 3,
                labelId: 0,
                enc: envelope.enc,
                ct: envelope.ct
            )
            let plaintext = try cryptoService.decryptMessage(
                encryptedContent: encrypted,
                envelope: hpkeEnvelope
            )
            // Content may be JSON with a "text" field, or raw text
            if let data = plaintext.data(using: .utf8),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let text = json["text"] as? String {
                decryptedContent = text
            } else {
                decryptedContent = plaintext
            }
        } catch {
            // Decryption failed — show encrypted indicator
        }
    }

    private var typeIcon: String {
        switch interaction.interactionType {
        case .comment: return "text.bubble"
        case .statusChange: return "arrow.triangle.2.circlepath"
        case .note: return "note.text"
        case .call: return "phone"
        case .message: return "message"
        case .fileUpload: return "arrow.up.doc"
        case .assessment: return "clipboard"
        case .referral: return "arrow.right.arrow.left"
        }
    }

    private var typeLabel: String {
        switch interaction.interactionType {
        case .comment: return NSLocalizedString("cases_interaction_comment", comment: "Comment")
        case .statusChange: return NSLocalizedString("cases_interaction_status", comment: "Status Change")
        case .note: return NSLocalizedString("cases_interaction_note", comment: "Note")
        case .call: return NSLocalizedString("cases_interaction_call", comment: "Call")
        case .message: return NSLocalizedString("cases_interaction_message", comment: "Message")
        case .fileUpload: return NSLocalizedString("cases_interaction_upload", comment: "File Upload")
        case .assessment: return NSLocalizedString("cases_interaction_assessment", comment: "Assessment")
        case .referral: return NSLocalizedString("cases_interaction_referral", comment: "Referral")
        }
    }

    private var typeColor: Color {
        switch interaction.interactionType {
        case .comment: return .blue
        case .statusChange: return .purple
        case .note: return .orange
        case .call: return .green
        case .message: return .teal
        case .fileUpload: return .indigo
        case .assessment: return .cyan
        case .referral: return .pink
        }
    }

    private var relativeTime: String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: interaction.createdAt) ?? ISO8601DateFormatter().date(from: interaction.createdAt) else {
            return ""
        }
        let rel = RelativeDateTimeFormatter()
        rel.unitsStyle = .abbreviated
        return rel.localizedString(for: date, relativeTo: Date())
    }
}
