import SwiftUI

// MARK: - CaseListView

/// Main case list screen with entity type tabs, status filtering, pull-to-refresh,
/// decrypted summary titles, and navigation to case detail.
struct CaseListView: View {
    @Environment(AppState.self) private var appState
    @Environment(HubContext.self) private var hubContext
    @State private var viewModel: CaseManagementViewModel?

    private var vm: CaseManagementViewModel {
        if let viewModel { return viewModel }
        let vm = CaseManagementViewModel(
            apiService: appState.apiService,
            cryptoService: appState.cryptoService
        )
        DispatchQueue.main.async { self.viewModel = vm }
        return vm
    }

    var body: some View {
        let vm = self.vm

        NavigationStack {
            Group {
                if vm.cmsEnabled == nil {
                    loadingView
                } else if vm.cmsEnabled == false {
                    cmsDisabledView
                } else if vm.isLoading && vm.records.isEmpty {
                    loadingView
                } else if vm.records.isEmpty && vm.entityTypeFilter == nil && vm.statusFilter == nil {
                    emptyStateView(vm: vm)
                } else {
                    caseListContent(vm: vm)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(NSLocalizedString("cases_title", comment: "Cases"))
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    if vm.cmsEnabled == true && !vm.entityTypes.isEmpty {
                        Button {
                            vm.showCreateSheet = true
                        } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityIdentifier("case-new-btn")
                    }
                }
                ToolbarItem(placement: .secondaryAction) {
                    Menu {
                        // Display type picker
                        Menu(NSLocalizedString("cms_display_type", comment: "Display")) {
                            ForEach(CaseDisplayType.allCases, id: \.self) { dt in
                                Button {
                                    vm.displayType = dt
                                } label: {
                                    Label(dt.rawValue.capitalized, systemImage: displayTypeIcon(dt))
                                }
                            }
                        }
                        // Cross-hub toggle
                        Button {
                            vm.crossHubEnabled.toggle()
                            Task { await vm.loadRecords() }
                        } label: {
                            Label(
                                vm.crossHubEnabled
                                    ? NSLocalizedString("cms_cross_hub_off", comment: "This Hub Only")
                                    : NSLocalizedString("cms_cross_hub", comment: "All Hubs"),
                                systemImage: vm.crossHubEnabled ? "globe.slash" : "globe"
                            )
                        }
                        .accessibilityIdentifier("cross-hub-toggle")
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .task(id: hubContext.activeHubId) {
                await vm.loadInitial()
            }
            .refreshable {
                await vm.refresh()
            }
            .sheet(isPresented: Binding(
                get: { vm.showCreateSheet },
                set: { vm.showCreateSheet = $0 }
            )) {
                CreateCaseSheet(
                    entityTypes: vm.entityTypes,
                    appState: appState
                ) { recordId in
                    vm.showCreateSheet = false
                    Task { await vm.refresh() }
                }
            }
        }
    }

    // MARK: - Loading

    private var loadingView: some View {
        VStack {
            Spacer()
            ProgressView()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("case-loading")
    }

    // MARK: - CMS Disabled

    private var cmsDisabledView: some View {
        BrandEmptyState(
            icon: "folder",
            title: NSLocalizedString("cases_not_enabled", comment: "Case management is not enabled"),
            message: appState.isAdmin
                ? NSLocalizedString("cases_enable_hint_admin", comment: "Enable case management and apply a template in Hub Settings.")
                : NSLocalizedString("cases_not_enabled_hint", comment: "An admin needs to enable case management.")
        )
        .accessibilityIdentifier("cms-not-enabled")
    }

    // MARK: - Empty State

    private func emptyStateView(vm: CaseManagementViewModel) -> some View {
        BrandEmptyState(
            icon: "folder.badge.plus",
            title: NSLocalizedString("cases_empty", comment: "No cases yet"),
            message: vm.entityTypes.isEmpty
                ? NSLocalizedString("cases_apply_template_hint", comment: "Apply a case management template to get started.")
                : NSLocalizedString("cases_empty_hint", comment: "Cases will appear here as your team creates them."),
            action: vm.entityTypes.isEmpty ? nil : {
                vm.showCreateSheet = true
            },
            actionLabel: vm.entityTypes.isEmpty ? nil : NSLocalizedString("cases_new", comment: "New Case"),
            actionAccessibilityID: "case-empty-create-btn"
        )
        .accessibilityIdentifier("case-empty-state")
    }

    // MARK: - Case List Content

    private func caseListContent(vm: CaseManagementViewModel) -> some View {
        VStack(spacing: 0) {
            // Entity type tabs
            if vm.entityTypes.count > 1 {
                entityTypeTabs(vm: vm)
            }

            // Status filter
            if !vm.allStatuses.isEmpty {
                statusFilterRow(vm: vm)
            }

            // Records list — display type determines rendering
            switch vm.displayType {
            case .calendar:
                EntityCalendarView(records: vm.records) { record in
                    Task { await vm.selectRecord(record) }
                }
                .accessibilityIdentifier("entity-calendar-view")
            case .timeline:
                EntityTimelineView(records: vm.records) { record in
                    Task { await vm.selectRecord(record) }
                }
                .accessibilityIdentifier("entity-timeline-view")
            case .table:
                List {
                    ForEach(vm.records) { record in
                        CaseCardRow(
                            record: record,
                            entityType: vm.entityType(for: record.entityTypeId),
                            statusDef: vm.statusDef(for: record),
                            decryptedTitle: vm.decryptedTitle(for: record.id)
                        )
                        .accessibilityIdentifier("case-card-\(record.id)")
                        .onTapGesture {
                            Task { await vm.selectRecord(record) }
                        }
                    }
                }
                .listStyle(.plain)
                .accessibilityIdentifier("case-list")
            }

            // Pagination
            if vm.totalPages > 1 {
                paginationBar(vm: vm)
            }
        }
        .sheet(item: Binding(
            get: { vm.selectedRecord },
            set: { vm.selectedRecord = $0 }
        )) { record in
            if let entityType = vm.selectedEntityType {
                CaseDetailView(
                    record: record,
                    entityType: entityType,
                    viewModel: vm,
                    appState: appState
                )
            }
        }
    }

    // MARK: - Entity Type Tabs

    private func entityTypeTabs(vm: CaseManagementViewModel) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                // All tab
                Button {
                    Task { await vm.setEntityTypeFilter(nil) }
                } label: {
                    Text(NSLocalizedString("cases_all_types", comment: "All"))
                        .font(.brand(.caption))
                        .fontWeight(vm.entityTypeFilter == nil ? .semibold : .regular)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(
                            vm.entityTypeFilter == nil
                                ? Color.brandPrimary
                                : Color.brandMuted
                        )
                        .foregroundStyle(
                            vm.entityTypeFilter == nil
                                ? .white
                                : .primary
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                .accessibilityIdentifier("case-tab-all")
                // Selection is otherwise conveyed only by fill colour — VoiceOver
                // users (and UI tests) could not tell which tab is active.
                .accessibilityAddTraits(vm.entityTypeFilter == nil ? .isSelected : [])

                // Per-type tabs
                ForEach(vm.entityTypes) { et in
                    Button {
                        Task { await vm.setEntityTypeFilter(et.id) }
                    } label: {
                        HStack(spacing: 4) {
                            if let color = et.color {
                                Circle()
                                    .fill((Color(hex: color) ?? .gray))
                                    .frame(width: 8, height: 8)
                            }
                            Text(et.label)
                                .font(.brand(.caption))
                                .fontWeight(vm.entityTypeFilter == et.id ? .semibold : .regular)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(
                            vm.entityTypeFilter == et.id
                                ? Color.brandPrimary
                                : Color.brandMuted
                        )
                        .foregroundStyle(
                            vm.entityTypeFilter == et.id
                                ? .white
                                : .primary
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .accessibilityIdentifier("case-tab-\(et.name)")
                    .accessibilityAddTraits(vm.entityTypeFilter == et.id ? .isSelected : [])
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .accessibilityIdentifier("case-type-tabs")
    }

    // MARK: - Status Filter

    private func statusFilterRow(vm: CaseManagementViewModel) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                // All statuses
                Button {
                    Task { await vm.setStatusFilter(nil) }
                } label: {
                    Text(NSLocalizedString("cases_all_statuses", comment: "All"))
                        .font(.brand(.caption2))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(vm.statusFilter == nil ? Color.brandPrimary.opacity(0.15) : Color.brandMuted)
                        .clipShape(Capsule())
                }
                .accessibilityIdentifier("case-status-filter-all")

                ForEach(vm.allStatuses) { status in
                    Button {
                        Task { await vm.setStatusFilter(status.value) }
                    } label: {
                        HStack(spacing: 4) {
                            Circle()
                                .fill((Color(hex: status.color ?? "#6b7280") ?? .gray))
                                .frame(width: 6, height: 6)
                            Text(status.label)
                                .font(.brand(.caption2))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(vm.statusFilter == status.value ? Color.brandPrimary.opacity(0.15) : Color.brandMuted)
                        .clipShape(Capsule())
                    }
                    .accessibilityIdentifier("case-status-filter-\(status.value)")
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 4)
        }
        .accessibilityIdentifier("case-status-filter")
    }

    // MARK: - Pagination

    private func paginationBar(vm: CaseManagementViewModel) -> some View {
        HStack {
            Text(String(format: NSLocalizedString("cases_page_info", comment: "Page X of Y"), vm.currentPage, vm.totalPages))
                .font(.brand(.caption2))
                .foregroundStyle(.secondary)

            Spacer()

            HStack(spacing: 8) {
                Button {
                    Task { await vm.previousPage() }
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.caption)
                }
                .disabled(vm.currentPage <= 1)
                .accessibilityIdentifier("case-page-prev")

                Button {
                    Task { await vm.nextPage() }
                } label: {
                    Image(systemName: "chevron.right")
                        .font(.caption)
                }
                .disabled(!vm.hasMorePages)
                .accessibilityIdentifier("case-page-next")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.brandCard)
        .accessibilityIdentifier("case-pagination")
    }
}

// MARK: - CaseCardRow

/// A single case card in the list showing case number, decrypted title, status,
/// entity type, assigned count, and relative timestamp.
private struct CaseCardRow: View {
    let record: CaseRecord
    let entityType: CaseEntityTypeDefinition?
    let statusDef: CaseEnumOption?
    let decryptedTitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Top row: case number + title + timestamp
            HStack {
                // Status dot + case number + title
                HStack(spacing: 6) {
                    Circle()
                        .fill((Color(hex: statusDef?.color ?? "#6b7280") ?? .gray))
                        .frame(width: 8, height: 8)

                    if let title = decryptedTitle {
                        Text("\(record.caseNumber ?? String(record.id.prefix(8))) \u{2014} \(title)")
                            .font(.brand(.subheadline))
                            .fontWeight(.medium)
                            .lineLimit(1)
                    } else {
                        Text(record.caseNumber ?? String(record.id.prefix(8)))
                            .font(.brand(.subheadline))
                            .fontWeight(.medium)
                    }
                }

                Spacer()

                // Relative timestamp
                Text(relativeTime(record.updatedAt))
                    .font(.brand(.caption2))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("case-card-timestamp")
            }

            // Bottom row: badges
            HStack(spacing: 6) {
                // Status badge
                if let status = statusDef {
                    HStack(spacing: 3) {
                        Circle()
                            .fill((Color(hex: status.color ?? "#6b7280") ?? .gray))
                            .frame(width: 5, height: 5)
                        Text(status.label)
                    }
                    .font(.brand(.caption2))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background((Color(hex: status.color ?? "#6b7280") ?? .gray).opacity(0.1))
                    .clipShape(Capsule())
                    .accessibilityIdentifier("case-card-status-badge")
                }

                // Severity badge
                if let sevHash = record.severityHash,
                   let sev = entityType?.severities?.first(where: { $0.value == sevHash }) {
                    HStack(spacing: 3) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 8))
                        Text(sev.label)
                    }
                    .font(.brand(.caption2))
                    .foregroundStyle((Color(hex: sev.color ?? "#6b7280") ?? .gray))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background((Color(hex: sev.color ?? "#6b7280") ?? .gray).opacity(0.1))
                    .clipShape(Capsule())
                }

                // Entity type badge
                if let et = entityType {
                    Text(et.label)
                        .font(.brand(.caption2))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.brandMuted)
                        .clipShape(Capsule())
                }

                // Assigned count
                if !record.assignedTo.isEmpty {
                    HStack(spacing: 2) {
                        Image(systemName: "person.2")
                            .font(.system(size: 9))
                        Text("\(record.assignedTo.count)")
                            .font(.brand(.caption2))
                    }
                    .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
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
}

// MARK: - CreateCaseSheet

/// Form for creating a new case record. Encrypts summary data (title, description,
/// default status/severity) and POSTs to `/api/records`.
private struct CreateCaseSheet: View {
    let entityTypes: [CaseEntityTypeDefinition]
    let appState: AppState
    let onCreated: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var selectedTypeId: String = ""
    @State private var title: String = ""
    @State private var description: String = ""
    @State private var isSubmitting: Bool = false
    @State private var errorMessage: String?

    private var selectedType: CaseEntityTypeDefinition? {
        entityTypes.first(where: { $0.id == selectedTypeId })
    }

    private var isFormValid: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !selectedTypeId.isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                // Entity type selection
                if entityTypes.count > 1 {
                    Section {
                        Picker(NSLocalizedString("cases_entity_type", comment: "Case Type"), selection: $selectedTypeId) {
                            Text(NSLocalizedString("cases_select_type", comment: "Select a type..."))
                                .tag("")
                            ForEach(entityTypes) { et in
                                HStack(spacing: 6) {
                                    if let color = et.color {
                                        Circle()
                                            .fill(Color(hex: color) ?? .gray)
                                            .frame(width: 8, height: 8)
                                    }
                                    Text(et.label)
                                }
                                .tag(et.id)
                            }
                        }
                        .accessibilityIdentifier("case-type-picker")

                        if let desc = selectedType?.description, !desc.isEmpty {
                            Text(desc)
                                .font(.brand(.caption))
                                .foregroundStyle(.secondary)
                        }
                    }
                } else if let singleType = entityTypes.first {
                    Section {
                        HStack(spacing: 6) {
                            if let color = singleType.color {
                                Circle()
                                    .fill(Color(hex: color) ?? .gray)
                                    .frame(width: 8, height: 8)
                            }
                            Text(singleType.label)
                                .font(.brand(.body))
                                .fontWeight(.medium)
                        }
                    }
                }

                // Title and description
                if !selectedTypeId.isEmpty {
                    Section {
                        TextField(
                            NSLocalizedString("cases_title_placeholder", comment: "Brief case description"),
                            text: $title
                        )
                        .font(.brand(.body))
                        .accessibilityIdentifier("case-title-input")
                    } header: {
                        HStack(spacing: 2) {
                            Text(NSLocalizedString("cases_title_label", comment: "Title"))
                            Text("*").foregroundStyle(Color.brandDestructive)
                        }
                    }

                    Section {
                        TextEditor(text: $description)
                            .frame(minHeight: 80)
                            .font(.brand(.body))
                            .accessibilityIdentifier("case-description-input")
                    } header: {
                        Text(NSLocalizedString("cases_description_label", comment: "Description"))
                    }

                    // E2EE indicator
                    Section {
                        HStack(spacing: 6) {
                            Image(systemName: "lock.fill")
                                .font(.caption)
                                .foregroundStyle(Color.brandPrimary)
                            Text(NSLocalizedString("cases_encrypted_note", comment: "Case data is encrypted end-to-end"))
                                .font(.brand(.caption))
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                // Error display
                if let error = errorMessage {
                    Section {
                        Text(error)
                            .font(.brand(.footnote))
                            .foregroundStyle(Color.brandDestructive)
                    }
                    .accessibilityIdentifier("case-create-error")
                }
            }
            .tint(Color.brandPrimary)
            .navigationTitle(NSLocalizedString("cases_new", comment: "New Case"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("common_cancel", comment: "Cancel")) {
                        dismiss()
                    }
                    .disabled(isSubmitting)
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await submitCase() }
                    } label: {
                        if isSubmitting {
                            ProgressView()
                        } else {
                            Text(NSLocalizedString("cases_create", comment: "Create"))
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(!isFormValid || isSubmitting)
                    .accessibilityIdentifier("case-create-submit")
                }
            }
            .loadingOverlay(
                isPresented: isSubmitting,
                message: NSLocalizedString("report_create_saving", comment: "Encrypting & submitting...")
            )
            .interactiveDismissDisabled(isSubmitting)
            .onAppear {
                // Auto-select if only one type
                if entityTypes.count == 1 {
                    selectedTypeId = entityTypes[0].id
                }
            }
        }
        .accessibilityIdentifier("create-case-sheet")
    }

    // MARK: - Submit

    private func submitCase() async {
        guard let entityType = selectedType else { return }
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else { return }

        isSubmitting = true
        errorMessage = nil

        // Ensure admin pubkey is loaded before encrypting
        await appState.ensureAdminPubkeyLoaded()

        do {
            let cryptoService = appState.cryptoService
            guard cryptoService.isUnlocked,
                  let encPubkey = cryptoService.encryptionPubkeyHex else {
                errorMessage = NSLocalizedString("cases_error_no_key", comment: "Encryption key not available")
                isSubmitting = false
                return
            }

            // Build reader pubkeys: self + admin
            var readerPubkeys = [encPubkey]
            if let adminPubkey = appState.adminDecryptionPubkey, adminPubkey != encPubkey {
                readerPubkeys.append(adminPubkey)
            }

            // Build summary JSON
            let defaultStatus = entityType.statuses.first(where: { $0.isDefault == true })
                ?? entityType.statuses.first(where: { $0.value == entityType.defaultStatus })
            let summary: [String: Any] = [
                "title": trimmedTitle,
                "description": description.trimmingCharacters(in: .whitespacesAndNewlines),
                "status": defaultStatus?.label ?? entityType.defaultStatus,
            ]
            let summaryJSON = String(data: try JSONSerialization.data(withJSONObject: summary), encoding: .utf8)!

            // Encrypt summary with HPKE envelopes for each reader
            let encrypted = try cryptoService.encryptNote(payload: summaryJSON, recipientPubkeys: readerPubkeys)

            // Build envelopes in the format the API expects
            let summaryEnvelopes: [[String: String]] = encrypted.envelopes.map { env in
                ["pubkey": env.pubkey, "enc": env.envelope.enc, "ct": env.envelope.ct]
            }

            // Build the request body
            let body: [String: Any] = [
                "entityTypeId": entityType.id,
                "statusHash": entityType.defaultStatus,
                "encryptedSummary": encrypted.ciphertextHex,
                "summaryEnvelopes": summaryEnvelopes,
                "assignedTo": [encPubkey],
            ]

            let jsonData = try JSONSerialization.data(withJSONObject: body)
            let response: CaseRecord = try await appState.apiService.request(
                method: "POST",
                path: appState.apiService.hp("/api/records"),
                rawBody: jsonData
            )

            onCreated(response.id)
        } catch {
            errorMessage = error.localizedDescription
            isSubmitting = false
        }
    }
}

// Color.init(hex:) is defined in ReportTypePicker.swift — reused here.

// MARK: - Display Type Icon Helper

private func displayTypeIcon(_ dt: CaseDisplayType) -> String {
    switch dt {
    case .table: return "list.bullet"
    case .calendar: return "calendar"
    case .timeline: return "clock"
    }
}
