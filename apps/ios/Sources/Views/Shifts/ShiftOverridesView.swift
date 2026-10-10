import SwiftUI

// MARK: - ShiftOverridesView

/// Admin management of shift overrides: cancel a date or substitute volunteers,
/// scoped to one shift or to every shift on that date. Parity with desktop's
/// `overrides-panel.tsx` (date range filter, create, delete).
struct ShiftOverridesView: View {
    @Bindable var viewModel: ShiftAdminViewModel
    @Environment(HubContext.self) private var hubContext

    @State private var showCreateSheet = false
    @State private var overridePendingDeletion: Override?

    var body: some View {
        List {
            if let error = viewModel.errorMessage {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.brand(.footnote))
                        .foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("overrides-error")
            }

            dateRangeSection
            overridesSection
        }
        .listStyle(.insetGrouped)
        .navigationTitle(NSLocalizedString("shifts_overrides_title", comment: "Shift Overrides"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showCreateSheet = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .foregroundStyle(Color.brandPrimary)
                }
                .accessibilityIdentifier("override-create-button")
                .accessibilityLabel(NSLocalizedString("shifts_overrides_create", comment: "Create Override"))
            }
        }
        .sheet(isPresented: $showCreateSheet) {
            OverrideCreateSheet(viewModel: viewModel, isPresented: $showCreateSheet)
        }
        .refreshable {
            await viewModel.loadOverrides()
        }
        .task(id: hubContext.activeHubId) {
            await viewModel.loadOverrides()
            await viewModel.loadShifts()
            await viewModel.loadUsers()
        }
        .alert(
            NSLocalizedString("shifts_overrides_delete", comment: "Delete Override"),
            isPresented: Binding(
                get: { overridePendingDeletion != nil },
                set: { if !$0 { overridePendingDeletion = nil } }
            )
        ) {
            Button(NSLocalizedString("cancel", comment: "Cancel"), role: .cancel) {}
            Button(NSLocalizedString("common_delete", comment: "Delete"), role: .destructive) {
                if let override = overridePendingDeletion {
                    Task { await viewModel.deleteOverride(id: override.id) }
                }
            }
        } message: {
            Text(NSLocalizedString("shifts_overrides_delete_confirm", comment: "Delete confirmation"))
        }
    }

    // MARK: - Date Range Filter

    private var dateRangeSection: some View {
        Section {
            DatePicker(
                NSLocalizedString("common_from", comment: "From"),
                selection: $viewModel.overrideFrom,
                displayedComponents: .date
            )
            .accessibilityIdentifier("override-from-picker")
            DatePicker(
                NSLocalizedString("common_to", comment: "To"),
                selection: $viewModel.overrideTo,
                displayedComponents: .date
            )
            .accessibilityIdentifier("override-to-picker")
        }
        .onChange(of: viewModel.overrideFrom) { _, _ in
            Task { await viewModel.loadOverrides() }
        }
        .onChange(of: viewModel.overrideTo) { _, _ in
            Task { await viewModel.loadOverrides() }
        }
    }

    // MARK: - Overrides List

    private var overridesSection: some View {
        Section {
            if viewModel.isLoading && viewModel.overrides.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("overrides-loading")
            } else if viewModel.overrides.isEmpty {
                BrandEmptyState(
                    icon: "calendar.badge.exclamationmark",
                    title: NSLocalizedString("shifts_overrides_empty", comment: "No overrides"),
                    message: NSLocalizedString("shifts_overrides_empty_subtitle", comment: "Empty state subtitle")
                )
                .accessibilityIdentifier("overrides-empty-state")
                .listRowBackground(Color.clear)
            } else {
                ForEach(viewModel.overrides) { override in
                    overrideRow(override)
                }
            }
        }
        .accessibilityIdentifier("override-list")
    }

    private func overrideRow(_ override: Override) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(override.date)
                    .font(.brand(.body))
                    .fontWeight(.medium)
                    .foregroundStyle(Color.brandForeground)

                HStack(spacing: 6) {
                    BadgeView(
                        text: override.type == .cancel
                            ? NSLocalizedString("shifts_overrides_type_cancel", comment: "Cancel shift")
                            : NSLocalizedString("shifts_overrides_type_substitute", comment: "Substitute volunteers"),
                        color: override.type == .cancel ? .brandDestructive : .brandPrimary,
                        style: .subtle
                    )

                    Text(override.shiftID.map { viewModel.shiftName(for: $0) }
                        ?? NSLocalizedString("shifts_overrides_scope_all", comment: "All shifts"))
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
                }

                if let note = override.encryptedNote, !note.isEmpty {
                    Text(note)
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                }
            }

            Spacer()

            Button {
                overridePendingDeletion = override
            } label: {
                Image(systemName: "trash")
                    .foregroundStyle(Color.brandDestructive)
            }
            .buttonStyle(.borderless)
            .accessibilityIdentifier("override-delete-\(override.id)")
        }
        .accessibilityIdentifier("override-row-\(override.id)")
    }
}

// MARK: - OverrideCreateSheet

/// Create form for a shift override: date, cancel/substitute type, optional
/// shift scope (default: every shift that day), replacement volunteers for a
/// substitute, and an optional note.
struct OverrideCreateSheet: View {
    @Bindable var viewModel: ShiftAdminViewModel
    @Binding var isPresented: Bool

    @State private var date = Date()
    @State private var type: SharedCreateShiftOverrideBodyType = .cancel
    @State private var selectedShiftId: String?
    @State private var selectedSubstitutes: Set<String> = []
    @State private var note = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker(
                        NSLocalizedString("shifts_overrides_date", comment: "Date"),
                        selection: $date,
                        displayedComponents: .date
                    )
                    .accessibilityIdentifier("override-date-picker")

                    Picker(
                        NSLocalizedString("shifts_overrides_type", comment: "Override Type"),
                        selection: $type
                    ) {
                        Text(NSLocalizedString("shifts_overrides_type_cancel", comment: "Cancel shift"))
                            .tag(SharedCreateShiftOverrideBodyType.cancel)
                        Text(NSLocalizedString("shifts_overrides_type_substitute", comment: "Substitute volunteers"))
                            .tag(SharedCreateShiftOverrideBodyType.substitute)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("override-type-picker")
                }

                Section {
                    Picker(
                        NSLocalizedString("shifts_overrides_scope", comment: "Shift"),
                        selection: $selectedShiftId
                    ) {
                        Text(NSLocalizedString("shifts_overrides_scope_all", comment: "All shifts"))
                            .tag(String?.none)
                        ForEach(viewModel.shifts) { shift in
                            Text(viewModel.shiftName(for: shift.id))
                                .tag(String?.some(shift.id))
                        }
                    }
                    .accessibilityIdentifier("override-shift-picker")
                }

                if type == .substitute {
                    Section {
                        if viewModel.users.isEmpty {
                            Text(NSLocalizedString("shifts_no_users_found", comment: "No volunteers found"))
                                .font(.brand(.caption))
                                .foregroundStyle(Color.brandMutedForeground)
                        } else {
                            ForEach(viewModel.users, id: \.pubkey) { user in
                                Button {
                                    if selectedSubstitutes.contains(user.pubkey) {
                                        selectedSubstitutes.remove(user.pubkey)
                                    } else {
                                        selectedSubstitutes.insert(user.pubkey)
                                    }
                                } label: {
                                    HStack {
                                        Text(user.name.isEmpty ? user.pubkey.truncatedPubkey() : user.name)
                                            .font(.brand(.body))
                                            .foregroundStyle(Color.brandForeground)
                                        Spacer()
                                        if selectedSubstitutes.contains(user.pubkey) {
                                            Image(systemName: "checkmark.circle.fill")
                                                .foregroundStyle(Color.brandPrimary)
                                        }
                                    }
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("override-substitute-\(user.pubkey)")
                            }
                        }
                    } header: {
                        Text(NSLocalizedString("shifts_assign_users", comment: "Assign Volunteers"))
                    }
                }

                Section {
                    TextField(
                        NSLocalizedString("shifts_overrides_note", comment: "Note"),
                        text: $note,
                        axis: .vertical
                    )
                    .accessibilityIdentifier("override-note-input")
                }
            }
            .navigationTitle(NSLocalizedString("shifts_overrides_create", comment: "Create Override"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        isPresented = false
                    }
                    .accessibilityIdentifier("override-create-cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("save", comment: "Save")) {
                        Task {
                            let created = await viewModel.createOverride(
                                shiftId: selectedShiftId,
                                date: date,
                                type: type,
                                substitutePubkeys: selectedSubstitutes.isEmpty ? nil : Array(selectedSubstitutes),
                                note: note
                            )
                            if created { isPresented = false }
                        }
                    }
                    .disabled(viewModel.isSaving)
                    .accessibilityIdentifier("override-save-button")
                }
            }
        }
    }
}
