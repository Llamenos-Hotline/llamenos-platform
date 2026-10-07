import SwiftUI

// MARK: - CreateEventView

/// Sheet for creating a new event. Collects title, description, date range,
/// and location, then encrypts and submits to the API.
struct CreateEventView: View {
    let viewModel: EventsViewModel
    var parentEventId: String? = nil
    let onDismiss: () -> Void

    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var title: String = ""
    @State private var description: String = ""
    @State private var startDate: Date = Date()
    @State private var endDate: Date = Date()
    @State private var hasEndDate: Bool = false
    @State private var location: String = ""
    @State private var selectedEntityTypeId: String?

    var body: some View {
        NavigationStack {
            Form {
                // Entity type picker (if multiple event types exist)
                if viewModel.eventEntityTypes.count > 1 {
                    Section {
                        Picker(
                            NSLocalizedString("events_event_type", comment: "Event Type"),
                            selection: Binding(
                                get: { selectedEntityTypeId ?? viewModel.eventEntityTypes.first?.id ?? "" },
                                set: { selectedEntityTypeId = $0 }
                            )
                        ) {
                            ForEach(viewModel.eventEntityTypes) { et in
                                Text(et.label).tag(et.id)
                            }
                        }
                        .accessibilityIdentifier("event-type-picker")
                    }
                }

                // Title and description
                Section {
                    TextField(
                        NSLocalizedString("events_title_placeholder", comment: "Event title"),
                        text: $title
                    )
                    .textInputAutocapitalization(.words)
                    .accessibilityIdentifier("event-title-field")

                    TextField(
                        NSLocalizedString("events_description_placeholder", comment: "Description (optional)"),
                        text: $description,
                        axis: .vertical
                    )
                    .lineLimit(3...8)
                    .accessibilityIdentifier("event-description-field")
                } header: {
                    Text(NSLocalizedString("events_details_section", comment: "Details"))
                }

                // Date range
                Section {
                    DatePicker(
                        NSLocalizedString("events_start_date", comment: "Start Date"),
                        selection: $startDate,
                        displayedComponents: [.date, .hourAndMinute]
                    )
                    .accessibilityIdentifier("event-start-date")

                    Toggle(
                        NSLocalizedString("events_has_end_date", comment: "Set End Date"),
                        isOn: $hasEndDate
                    )
                    .accessibilityIdentifier("event-has-end-date")

                    if hasEndDate {
                        DatePicker(
                            NSLocalizedString("events_end_date", comment: "End Date"),
                            selection: $endDate,
                            in: startDate...,
                            displayedComponents: [.date, .hourAndMinute]
                        )
                        .accessibilityIdentifier("event-end-date")
                    }
                } header: {
                    Text(NSLocalizedString("events_dates_section", comment: "Dates"))
                }

                // Location
                Section {
                    TextField(
                        NSLocalizedString("events_location_placeholder", comment: "Approximate location (optional)"),
                        text: $location
                    )
                    .accessibilityIdentifier("event-location-field")
                } header: {
                    Text(NSLocalizedString("events_location_section", comment: "Location"))
                } footer: {
                    Text(NSLocalizedString(
                        "events_location_help",
                        comment: "Enter an approximate location. Exact coordinates are never stored for safety."
                    ))
                }
            }
            .navigationTitle(
                parentEventId != nil
                    ? NSLocalizedString("events_create_sub_event", comment: "Create Sub-Event")
                    : NSLocalizedString("events_new_event", comment: "New Event")
            )
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("common_cancel", comment: "Cancel")) {
                        dismiss()
                        onDismiss()
                    }
                    .accessibilityIdentifier("event-create-cancel")
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("common_create", comment: "Create")) {
                        Task { await submitEvent() }
                    }
                    .disabled(
                        title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || viewModel.isSaving
                    )
                    .accessibilityIdentifier("event-create-submit")
                }
            }
            .onAppear {
                // Default to first event entity type
                if selectedEntityTypeId == nil {
                    selectedEntityTypeId = viewModel.eventEntityTypes.first?.id
                }
                // Default end date to 2 hours after start
                endDate = startDate.addingTimeInterval(7200)
            }
        }
    }

    // MARK: - Submit

    private func submitEvent() async {
        guard let entityTypeId = selectedEntityTypeId ?? viewModel.eventEntityTypes.first?.id else {
            return
        }

        // Resolve the admin decryption pubkey before encrypting: the server
        // stores `detailEnvelopes` verbatim, so details wrapped only for the
        // author stay permanently unreadable to admins.
        await appState.ensureAdminPubkeyLoaded()

        let success = await viewModel.createEvent(
            entityTypeId: entityTypeId,
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil
                : description.trimmingCharacters(in: .whitespacesAndNewlines),
            startDate: startDate,
            endDate: hasEndDate ? endDate : nil,
            location: location.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil
                : location.trimmingCharacters(in: .whitespacesAndNewlines),
            adminPubkeys: [appState.adminDecryptionPubkey].compactMap { $0 }
        )

        if success {
            dismiss()
            onDismiss()
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Create Event") {
    CreateEventView(
        viewModel: EventsViewModel(
            apiService: APIService(cryptoService: CryptoService(), hubContext: HubContext()),
            cryptoService: CryptoService()
        ),
        onDismiss: {}
    )
    .environment(AppState(hubContext: HubContext()))
}
#endif
