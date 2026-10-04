import SwiftUI

// MARK: - EventDetailView

/// Detail view for a single event. Shows header info, date range, location,
/// description, sub-events, and linked records/reports.
struct EventDetailView: View {
    let event: EventListResponseEvent
    let viewModel: EventsViewModel

    @Environment(AppState.self) private var appState
    @State private var activeTab: EventDetailTab = .details
    @State private var showCreateSubEvent: Bool = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Header card
                headerSection

                // Tab bar
                tabBar

                // Tab content
                tabContent
            }
        }
        .navigationTitle(displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if appState.hasPermission("events:update") {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button {
                            showCreateSubEvent = true
                        } label: {
                            Label(
                                NSLocalizedString("events_create_sub_event", comment: "Create Sub-Event"),
                                systemImage: "plus.square.on.square"
                            )
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityIdentifier("event-detail-menu")
                }
            }
        }
        .task {
            await viewModel.selectEvent(event)
        }
        .sheet(isPresented: $showCreateSubEvent) {
            CreateEventView(viewModel: viewModel, parentEventId: event.id) {
                showCreateSubEvent = false
            }
        }
    }

    // MARK: - Display Title

    private var displayTitle: String {
        viewModel.decryptedTitle(for: event.id)
            ?? event.caseNumber
            ?? String(event.id.prefix(8))
    }

    // MARK: - Header Section

    private var headerSection: some View {
        BrandCard(padding: 16) {
            VStack(alignment: .leading, spacing: 12) {
                // Title row
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(displayTitle)
                            .font(.brand(.title3))
                            .fontWeight(.bold)
                            .foregroundStyle(Color.brandForeground)

                        if let caseNumber = event.caseNumber {
                            Text(caseNumber)
                                .font(.brandMono(.caption))
                                .foregroundStyle(Color.brandMutedForeground)
                        }
                    }

                    Spacer()

                    if let statusDef = viewModel.statusDef(for: event) {
                        BadgeView(
                            text: statusDef.label,
                            icon: nil,
                            color: Color(hex: statusDef.color ?? "#6b7280") ?? .gray,
                            style: .subtle
                        )
                    }
                }

                Divider()

                // Date range
                HStack(spacing: 16) {
                    dateRow(
                        label: NSLocalizedString("events_start_date", comment: "Start"),
                        date: event.startDate
                    )

                    if let endDate = event.endDate {
                        dateRow(
                            label: NSLocalizedString("events_end_date", comment: "End"),
                            date: endDate
                        )
                    }
                }

                // Location
                if let location = event.locationApproximate, !location.isEmpty {
                    HStack(spacing: 6) {
                        Image(systemName: "mappin.and.ellipse")
                            .font(.system(size: 14))
                            .foregroundStyle(Color.brandPrimary)
                        Text(location)
                            .font(.brand(.subheadline))
                            .foregroundStyle(Color.brandForeground)
                    }
                }

                // Description
                if let details = viewModel.decryptedDetails[event.id],
                   let description = details.description, !description.isEmpty {
                    Text(description)
                        .font(.brand(.subheadline))
                        .foregroundStyle(Color.brandMutedForeground)
                        .lineLimit(4)
                }

                // Stats row
                HStack(spacing: 16) {
                    statBadge(
                        icon: "folder.fill",
                        count: Int(event.caseCount),
                        label: NSLocalizedString("events_cases", comment: "Cases")
                    )
                    statBadge(
                        icon: "doc.text.fill",
                        count: Int(event.reportCount),
                        label: NSLocalizedString("events_reports", comment: "Reports")
                    )
                    statBadge(
                        icon: "square.stack.fill",
                        count: Int(event.subEventCount),
                        label: NSLocalizedString("events_sub_events", comment: "Sub-Events")
                    )
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    // MARK: - Date Row

    private func dateRow(label: String, date: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.brand(.caption2))
                .foregroundStyle(Color.brandMutedForeground)
                .textCase(.uppercase)
            HStack(spacing: 4) {
                Image(systemName: "calendar")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.brandPrimary)
                Text(formattedDate(date))
                    .font(.brand(.subheadline))
                    .foregroundStyle(Color.brandForeground)
            }
        }
    }

    // MARK: - Stat Badge

    private func statBadge(icon: String, count: Int, label: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 11))
            Text("\(count)")
                .font(.brand(.caption))
                .fontWeight(.medium)
            Text(label)
                .font(.brand(.caption2))
        }
        .foregroundStyle(Color.brandMutedForeground)
    }

    // MARK: - Tab Bar

    private var tabBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(EventDetailTab.allCases, id: \.self) { tab in
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            activeTab = tab
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: tab.icon)
                                .font(.system(size: 12))
                            Text(tab.label)
                                .font(.brand(.caption))
                                .fontWeight(.medium)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(
                            activeTab == tab
                                ? Color.brandPrimary.opacity(0.12)
                                : Color.clear
                        )
                        .foregroundStyle(
                            activeTab == tab
                                ? Color.brandPrimary
                                : Color.brandMutedForeground
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .accessibilityIdentifier("event-tab-\(tab.rawValue)")
                }
            }
            .padding(.horizontal, 16)
        }
        .padding(.vertical, 8)
    }

    // MARK: - Tab Content

    @ViewBuilder
    private var tabContent: some View {
        switch activeTab {
        case .details:
            detailsTab
        case .subEvents:
            subEventsTab
        case .linkedCases:
            linkedCasesTab
        case .linkedReports:
            linkedReportsTab
        }
    }

    // MARK: - Details Tab

    private var detailsTab: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let details = viewModel.decryptedDetails[event.id] {
                if let description = details.description, !description.isEmpty {
                    BrandCard(padding: 16) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(NSLocalizedString("events_description", comment: "Description"))
                                .font(.brand(.subheadline))
                                .fontWeight(.semibold)
                                .foregroundStyle(Color.brandForeground)
                            Text(description)
                                .font(.brand(.body))
                                .foregroundStyle(Color.brandForeground)
                        }
                    }
                }
            } else {
                BrandCard(padding: 16) {
                    HStack {
                        Image(systemName: "lock.fill")
                            .foregroundStyle(Color.brandMutedForeground)
                        Text(NSLocalizedString(
                            "events_encrypted_details",
                            comment: "Event details are encrypted"
                        ))
                        .font(.brand(.subheadline))
                        .foregroundStyle(Color.brandMutedForeground)
                    }
                }
            }

            // Metadata card
            BrandCard(padding: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(NSLocalizedString("events_metadata", comment: "Metadata"))
                        .font(.brand(.subheadline))
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.brandForeground)

                    metadataRow(
                        label: NSLocalizedString("events_event_id", comment: "Event ID"),
                        value: String(event.id.prefix(12)) + "..."
                    )
                    metadataRow(
                        label: NSLocalizedString("events_created", comment: "Created"),
                        value: formattedDate(event.createdAt)
                    )
                    metadataRow(
                        label: NSLocalizedString("events_updated", comment: "Updated"),
                        value: formattedDate(event.updatedAt)
                    )
                    metadataRow(
                        label: NSLocalizedString("events_location_precision", comment: "Location Precision"),
                        value: event.locationPrecision.rawValue.capitalized
                    )
                }
            }
        }
        .padding(.horizontal, 16)
        .accessibilityIdentifier("event-details-tab")
    }

    // MARK: - Sub-Events Tab

    private var subEventsTab: some View {
        Group {
            if viewModel.isLoadingLinks {
                VStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .frame(maxWidth: .infinity, minHeight: 200)
            } else if viewModel.subEvents.isEmpty {
                emptyTabState(
                    icon: "square.stack",
                    message: NSLocalizedString(
                        "events_no_sub_events",
                        comment: "No sub-events for this event."
                    )
                )
            } else {
                VStack(spacing: 8) {
                    ForEach(viewModel.subEvents) { subEvent in
                        BrandCard(padding: 12) {
                            HStack(spacing: 10) {
                                Image(systemName: "calendar")
                                    .font(.system(size: 14))
                                    .foregroundStyle(Color.brandPrimary)

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(viewModel.decryptedTitle(for: subEvent.id) ?? subEvent.caseNumber ?? String(subEvent.id.prefix(8)))
                                        .font(.brand(.body))
                                        .fontWeight(.medium)
                                        .foregroundStyle(Color.brandForeground)
                                    Text(formattedDate(subEvent.startDate))
                                        .font(.brand(.caption))
                                        .foregroundStyle(Color.brandMutedForeground)
                                }
                                Spacer()
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
            }
        }
        .accessibilityIdentifier("event-sub-events-tab")
    }

    // MARK: - Linked Cases Tab

    private var linkedCasesTab: some View {
        Group {
            if viewModel.isLoadingLinks {
                VStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .frame(maxWidth: .infinity, minHeight: 200)
            } else if viewModel.linkedCases.isEmpty {
                emptyTabState(
                    icon: "folder",
                    message: NSLocalizedString(
                        "events_no_linked_cases",
                        comment: "No cases linked to this event."
                    )
                )
            } else {
                VStack(spacing: 8) {
                    ForEach(viewModel.linkedCases, id: \.recordID) { link in
                        BrandCard(padding: 12) {
                            HStack(spacing: 10) {
                                Image(systemName: "folder.fill")
                                    .font(.system(size: 14))
                                    .foregroundStyle(Color.brandPrimary)

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(String(link.recordID.prefix(12)) + "...")
                                        .font(.brandMono(.subheadline))
                                        .foregroundStyle(Color.brandForeground)
                                    if !link.linkedAt.isEmpty {
                                        Text(formattedDate(link.linkedAt))
                                            .font(.brand(.caption))
                                            .foregroundStyle(Color.brandMutedForeground)
                                    }
                                }
                                Spacer()
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
            }
        }
        .accessibilityIdentifier("event-linked-cases-tab")
    }

    // MARK: - Linked Reports Tab

    private var linkedReportsTab: some View {
        Group {
            if viewModel.isLoadingLinks {
                VStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .frame(maxWidth: .infinity, minHeight: 200)
            } else if viewModel.linkedReports.isEmpty {
                emptyTabState(
                    icon: "doc.text",
                    message: NSLocalizedString(
                        "events_no_linked_reports",
                        comment: "No reports linked to this event."
                    )
                )
            } else {
                VStack(spacing: 8) {
                    ForEach(viewModel.linkedReports, id: \.reportID) { link in
                        BrandCard(padding: 12) {
                            HStack(spacing: 10) {
                                Image(systemName: "doc.text.fill")
                                    .font(.system(size: 14))
                                    .foregroundStyle(Color.brandPrimary)

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(String(link.reportID.prefix(12)) + "...")
                                        .font(.brandMono(.subheadline))
                                        .foregroundStyle(Color.brandForeground)
                                    if !link.linkedAt.isEmpty {
                                        Text(formattedDate(link.linkedAt))
                                            .font(.brand(.caption))
                                            .foregroundStyle(Color.brandMutedForeground)
                                    }
                                }
                                Spacer()
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
            }
        }
        .accessibilityIdentifier("event-linked-reports-tab")
    }

    // MARK: - Empty Tab State

    private func emptyTabState(icon: String, message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 32))
                .foregroundStyle(Color.brandMutedForeground.opacity(0.5))
            Text(message)
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    // MARK: - Metadata Row

    private func metadataRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.brand(.caption))
                .foregroundStyle(Color.brandMutedForeground)
            Spacer()
            Text(value)
                .font(.brand(.caption))
                .foregroundStyle(Color.brandForeground)
        }
    }

    // MARK: - Date Formatting

    private func formattedDate(_ isoString: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: isoString) {
            return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)
        }
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: isoString) {
            return DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)
        }
        return isoString
    }
}

// MARK: - EventDetailTab

enum EventDetailTab: String, CaseIterable, Sendable {
    case details
    case subEvents = "sub_events"
    case linkedCases = "linked_cases"
    case linkedReports = "linked_reports"

    var label: String {
        switch self {
        case .details:
            return NSLocalizedString("events_tab_details", comment: "Details")
        case .subEvents:
            return NSLocalizedString("events_tab_sub_events", comment: "Sub-Events")
        case .linkedCases:
            return NSLocalizedString("events_tab_cases", comment: "Cases")
        case .linkedReports:
            return NSLocalizedString("events_tab_reports", comment: "Reports")
        }
    }

    var icon: String {
        switch self {
        case .details: return "doc.text"
        case .subEvents: return "square.stack"
        case .linkedCases: return "folder"
        case .linkedReports: return "doc.text.fill"
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Event Detail") {
    NavigationStack {
        EventDetailView(
            event: EventListResponseEvent(
                blindIndexes: [:],
                caseCount: 3,
                caseNumber: "EVT-001",
                createdAt: "2026-03-15T08:00:00Z",
                createdBy: "pubkey123",
                detailEnvelopes: [
                    SharedAdminEnvelope(ct: "ct", enc: "enc", pubkey: "pubkey123"),
                ],
                encryptedDetails: "ciphertext",
                endDate: "2026-03-15T18:00:00Z",
                entityTypeID: "et-1",
                eventTypeHash: "protest",
                hubID: "hub-1",
                id: "test-id",
                locationApproximate: "Downtown Portland",
                locationPrecision: .neighborhood,
                parentEventID: nil,
                reportCount: 5,
                startDate: "2026-03-15T10:00:00Z",
                statusHash: "active",
                subEventCount: 1,
                updatedAt: "2026-03-15T12:00:00Z"
            ),
            viewModel: EventsViewModel(
                apiService: APIService(cryptoService: CryptoService(), hubContext: HubContext()),
                cryptoService: CryptoService()
            )
        )
        .environment(AppState(hubContext: HubContext()))
    }
}
#endif
