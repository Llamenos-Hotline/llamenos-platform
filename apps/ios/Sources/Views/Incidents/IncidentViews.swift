import SwiftUI

// MARK: - IncidentBanner

/// The persistent incident banner (operator rule V). Shown by `MainTabView` above every
/// tab, with no dismiss control: it goes away only when the server stops listing the
/// incident. Tapping it opens the incident view; it never switches hub.
struct IncidentBanner: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        let incidentService = appState.incidentService
        let rows = incidentService.rows(activeHubId: appState.hubContext.activeHubId)
        if !rows.isEmpty {
            Button {
                incidentService.isIncidentViewPresented = true
            } label: {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(rows) { row in
                        IncidentRowContent(row: row)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(Color.red.opacity(0.12))
                .foregroundStyle(Color.red)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(NSLocalizedString("incident_title", comment: "Active incidents"))
            .accessibilityIdentifier("incident-banner")
        }
    }
}

// MARK: - IncidentRowContent

/// One incident: category, state, count since opening, and its hub when not the active one.
struct IncidentRowContent: View {
    let row: IncidentRow

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(Self.categoryLabel(row.incident.category)) · \(NSLocalizedString("incident_opened", comment: "Happening now"))")
                    .font(.brand(.caption))
                    .fontWeight(.semibold)
                Text(L10n.format(
                    "incident_ongoing",
                    comment: "{count} events since {time}",
                    String(row.incident.totalCount),
                    Self.openedTime(row.incident.openedAt)
                ))
                .font(.brand(.caption))
                if row.inOtherHub {
                    Text(row.otherHubName.map { L10n.format("incident_in_hub", comment: "In {hub}", $0) }
                        ?? NSLocalizedString("incident_other_hub", comment: "In another hub"))
                        .font(.brand(.caption))
                        .accessibilityIdentifier("incident-hub-\(row.incident.id)")
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("incident-row-\(row.incident.id)")
    }

    /// The category is extensible: one this build does not know is shown under the generic title.
    static func categoryLabel(_ category: String) -> String {
        switch category {
        case "spam": return NSLocalizedString("incident_category_spam", comment: "Spam and unwanted calls")
        case "provider-media": return NSLocalizedString("incident_category_provider_media", comment: "Recordings left at the phone provider")
        case "erasure-deadline": return NSLocalizedString("incident_category_erasure_deadline", comment: "Overdue erasure requests")
        case "ban-expiry": return NSLocalizedString("incident_category_ban_expiry", comment: "Bans about to expire")
        case "channel-disabled": return NSLocalizedString("incident_category_channel_disabled", comment: "Contacts turned away on a switched-off channel")
        default: return NSLocalizedString("incident_title", comment: "Active incidents")
        }
    }

    private static func openedTime(_ iso: String) -> String {
        guard let date = DateFormatting.parseISO(iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

// MARK: - IncidentsView

/// The incident view: every open incident the user is responsible for, in every member
/// hub. Opened from the banner and from the content-free incident push, which carries
/// nothing — opening this view is what fetches.
struct IncidentsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let rows = appState.incidentService.rows(activeHubId: appState.hubContext.activeHubId)
        NavigationStack {
            Group {
                if rows.isEmpty {
                    Text(NSLocalizedString("common_no_data", comment: "No data available"))
                        .font(.brand(.body))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityIdentifier("incidents-empty")
                } else {
                    List(rows) { row in
                        IncidentRowContent(row: row)
                            .foregroundStyle(Color.red)
                    }
                    .accessibilityIdentifier("incidents-list")
                }
            }
            .navigationTitle(NSLocalizedString("incident_title", comment: "Active incidents"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("common_close", comment: "Close")) { dismiss() }
                        .accessibilityIdentifier("incidents-close")
                }
            }
            .task { await appState.refreshIncidents() }
        }
    }
}
