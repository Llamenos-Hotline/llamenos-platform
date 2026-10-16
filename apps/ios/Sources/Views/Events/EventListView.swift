import SwiftUI

// MARK: - EventListView

/// Main events screen. Lists CMS events with search, pull-to-refresh, and navigation
/// to event details. Events are CMS records with category='event'.
struct EventListView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModelBox = ViewModelBox<EventsViewModel>()
    @State private var showCreateEvent: Bool = false

    private var vm: EventsViewModel {
        if let existing = viewModelBox.value { return existing }
        let vm = EventsViewModel(
            apiService: appState.apiService,
            cryptoService: appState.cryptoService
        )
        viewModelBox.value = vm
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
                } else if vm.isLoading && vm.events.isEmpty {
                    loadingView
                } else if vm.events.isEmpty {
                    emptyStateView(vm: vm)
                } else {
                    eventListContent(vm: vm)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(NSLocalizedString("events_title", comment: "Events"))
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    if vm.cmsEnabled == true && !vm.eventEntityTypes.isEmpty {
                        Button {
                            showCreateEvent = true
                        } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityIdentifier("events-create-btn")
                    }
                }
            }
            .task {
                await vm.loadInitial()
            }
            .refreshable {
                await vm.refresh()
            }
            .sheet(isPresented: $showCreateEvent) {
                CreateEventView(viewModel: vm) {
                    showCreateEvent = false
                }
            }
            .navigationDestination(for: String.self) { eventId in
                if let event = vm.events.first(where: { $0.id == eventId }) {
                    EventDetailView(event: event, viewModel: vm)
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
        .accessibilityIdentifier("events-loading")
    }

    // MARK: - CMS Disabled

    private var cmsDisabledView: some View {
        BrandEmptyState(
            icon: "calendar",
            title: NSLocalizedString("events_cms_disabled_title", comment: "Events Not Available"),
            message: NSLocalizedString(
                "events_cms_disabled_message",
                comment: "Case management must be enabled to use events."
            )
        )
    }

    // MARK: - Empty State

    private func emptyStateView(vm: EventsViewModel) -> some View {
        BrandEmptyState(
            icon: "calendar",
            title: NSLocalizedString("events_empty_title", comment: "No Events"),
            message: NSLocalizedString(
                "events_empty_message",
                comment: "No events have been created yet."
            ),
            action: { showCreateEvent = true },
            actionLabel: NSLocalizedString("events_new_event", comment: "New Event"),
            actionAccessibilityID: "events-empty-create-btn"
        )
    }

    // MARK: - Event List Content

    private func eventListContent(vm: EventsViewModel) -> some View {
        List {
            // Search bar section
            Section {
                HStack {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(Color.brandMutedForeground)
                    TextField(
                        NSLocalizedString("events_search_placeholder", comment: "Search events..."),
                        text: Binding(
                            get: { vm.searchQuery },
                            set: { vm.searchQuery = $0 }
                        )
                    )
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("events-search-field")

                    if !vm.searchQuery.isEmpty {
                        Button {
                            vm.searchQuery = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(Color.brandMutedForeground)
                        }
                    }
                }
            }

            // Event rows
            Section {
                let filteredEvents = filteredEvents(vm: vm)

                if filteredEvents.isEmpty && !vm.searchQuery.isEmpty {
                    HStack {
                        Spacer()
                        VStack(spacing: 8) {
                            Image(systemName: "magnifyingglass")
                                .font(.title2)
                                .foregroundStyle(Color.brandMutedForeground)
                            Text(NSLocalizedString(
                                "events_no_results",
                                comment: "No events match your search"
                            ))
                            .font(.brand(.subheadline))
                            .foregroundStyle(Color.brandMutedForeground)
                        }
                        .padding(.vertical, 32)
                        Spacer()
                    }
                } else {
                    ForEach(filteredEvents) { event in
                        NavigationLink(value: event.id) {
                            EventRow(event: event, viewModel: vm)
                        }
                        .accessibilityIdentifier("event-row-\(event.id)")
                    }
                }
            } header: {
                HStack {
                    Text(NSLocalizedString("events_list_header", comment: "Events"))
                    Spacer()
                    Text("\(vm.totalEvents)")
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                }
            }

            // Pagination
            if vm.totalPages > 1 {
                Section {
                    HStack {
                        Button {
                            Task { await vm.previousPage() }
                        } label: {
                            Image(systemName: "chevron.left")
                        }
                        .disabled(vm.currentPage <= 1)

                        Spacer()

                        Text(L10n.format(
                            "events_page_indicator",
                            comment: "Page %d of %d",
                            vm.currentPage, vm.totalPages
                        ))
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)

                        Spacer()

                        Button {
                            Task { await vm.nextPage() }
                        } label: {
                            Image(systemName: "chevron.right")
                        }
                        .disabled(!vm.hasMorePages)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("events-list")
    }

    // MARK: - Filtering

    private func filteredEvents(vm: EventsViewModel) -> [AppCaseEvent] {
        guard !vm.searchQuery.isEmpty else { return vm.events }
        let query = vm.searchQuery.lowercased()
        return vm.events.filter { event in
            if let title = vm.decryptedTitle(for: event.id),
               title.lowercased().contains(query) {
                return true
            }
            if let caseNumber = event.caseNumber,
               caseNumber.lowercased().contains(query) {
                return true
            }
            if let location = event.locationApproximate,
               location.lowercased().contains(query) {
                return true
            }
            return false
        }
    }
}

// MARK: - EventRow

private struct EventRow: View {
    let event: AppCaseEvent
    let viewModel: EventsViewModel

    var body: some View {
        HStack(spacing: 12) {
            // Status indicator
            Circle()
                .fill(statusColor)
                .frame(width: 10, height: 10)

            VStack(alignment: .leading, spacing: 4) {
                // Title
                Text(displayTitle)
                    .font(.brand(.body))
                    .fontWeight(.medium)
                    .foregroundStyle(Color.brandForeground)
                    .lineLimit(1)

                // Date and location
                HStack(spacing: 8) {
                    HStack(spacing: 3) {
                        Image(systemName: "calendar")
                            .font(.system(size: 10))
                        Text(formattedDate)
                            .font(.brand(.caption))
                    }
                    .foregroundStyle(Color.brandMutedForeground)

                    if let location = event.locationApproximate, !location.isEmpty {
                        HStack(spacing: 3) {
                            Image(systemName: "mappin")
                                .font(.system(size: 10))
                            Text(location)
                                .font(.brand(.caption))
                                .lineLimit(1)
                        }
                        .foregroundStyle(Color.brandMutedForeground)
                    }
                }

                // Metadata badges
                HStack(spacing: 6) {
                    if let statusDef = viewModel.statusDef(for: event) {
                        BadgeView(
                            text: statusDef.label,
                            icon: nil,
                            color: Color(hex: statusDef.color ?? "#6b7280") ?? .gray,
                            style: .subtle
                        )
                    }

                    if let caseCount = event.caseCount, caseCount > 0 {
                        HStack(spacing: 2) {
                            Image(systemName: "folder.fill")
                                .font(.system(size: 9))
                            Text("\(caseCount)")
                                .font(.brand(.caption2))
                        }
                        .foregroundStyle(Color.brandMutedForeground)
                    }

                    if let reportCount = event.reportCount, reportCount > 0 {
                        HStack(spacing: 2) {
                            Image(systemName: "doc.text.fill")
                                .font(.system(size: 9))
                            Text("\(reportCount)")
                                .font(.brand(.caption2))
                        }
                        .foregroundStyle(Color.brandMutedForeground)
                    }
                }
            }

            Spacer()
        }
        .padding(.vertical, 4)
    }

    private var displayTitle: String {
        if let title = viewModel.decryptedTitle(for: event.id) {
            return title
        }
        return event.caseNumber ?? event.id.prefix(8).description
    }

    private var formattedDate: String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: event.startDate) else {
            // Try without fractional seconds
            formatter.formatOptions = [.withInternetDateTime]
            guard let date = formatter.date(from: event.startDate) else {
                return event.startDate
            }
            return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .none)
        }
        return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .none)
    }

    private var statusColor: Color {
        if let statusDef = viewModel.statusDef(for: event),
           let color = statusDef.color {
            return Color(hex: color) ?? Color.gray
        }
        return Color.gray
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Events List") {
    EventListView()
        .environment(AppState(hubContext: HubContext()))
}
#endif
