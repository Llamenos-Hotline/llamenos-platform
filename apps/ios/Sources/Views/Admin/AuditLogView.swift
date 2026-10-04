import SwiftUI

// MARK: - AuditLogView

/// Admin view for the hash-chained audit log. Shows a paginated list of all
/// system actions with actor, action type, timestamp, and chain hash.
struct AuditLogView: View {
    @Bindable var viewModel: AdminViewModel
    @Environment(HubContext.self) private var hubContext

    var body: some View {
        ZStack {
            if viewModel.isLoadingAudit && viewModel.auditEntries.isEmpty {
                loadingState
            } else if viewModel.auditEntries.isEmpty {
                emptyState
            } else {
                auditList
            }
        }
        .refreshable {
            viewModel.isLoadingAudit = false
            await viewModel.loadAuditLog()
        }
        .task(id: hubContext.activeHubId) {
            await viewModel.loadAuditLog()
        }
    }

    // MARK: - Audit List

    private var auditList: some View {
        List {
            // Summary header
            Section {
                HStack {
                    Label {
                        Text(L10n.format(
                            "admin_audit_total",
                            comment: "%d total entries",
                            viewModel.auditTotal
                        ))
                        .font(.brand(.subheadline))
                    } icon: {
                        Image(systemName: "list.clipboard.fill")
                            .foregroundStyle(Color.brandPrimary)
                    }

                    Spacer()

                    Image(systemName: "link")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(NSLocalizedString("admin_audit_hash_chained", comment: "Hash-chained"))
                        .font(.brand(.caption))
                        .foregroundStyle(.secondary)
                }
            }

            // Entries
            Section {
                ForEach(viewModel.auditEntries) { entry in
                    AuditEntryRowView(entry: entry)
                        .accessibilityIdentifier("audit-entry-\(entry.id)")
                }

                // Load more button
                if viewModel.hasMoreAudit {
                    HStack {
                        Spacer()
                        if viewModel.isLoadingMoreAudit {
                            ProgressView()
                                .padding()
                        } else {
                            Button {
                                Task { await viewModel.loadMoreAuditEntries() }
                            } label: {
                                Text(NSLocalizedString("admin_load_more", comment: "Load More"))
                                    .font(.brand(.subheadline))
                                    .foregroundStyle(Color.brandPrimary)
                            }
                            .padding()
                            .accessibilityIdentifier("load-more-audit")
                        }
                        Spacer()
                    }
                    .listRowSeparator(.hidden)
                }
            } header: {
                Text(NSLocalizedString("admin_audit_entries_header", comment: "Entries"))
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("audit-log-list")
    }

    // MARK: - Empty State

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("admin_no_audit", comment: "No Audit Entries"),
                systemImage: "list.clipboard"
            )
        } description: {
            Text(NSLocalizedString(
                "admin_no_audit_message",
                comment: "System actions will be logged here."
            ))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("audit-empty-state")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("admin_loading_audit", comment: "Loading audit log..."))
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("audit-loading")
    }
}

// MARK: - AuditEntryRowView

/// A single audit log entry row showing the action, actor, timestamp, and hash chain info.
struct AuditEntryRowView: View {
    let entry: AppAuditEntry

    @State private var isExpanded: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Action and timestamp header
            HStack {
                Image(systemName: actionIcon)
                    .font(.body)
                    .foregroundStyle(actionColor)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.actionDisplay)
                        .font(.brand(.subheadline))
                        .fontWeight(.medium)
                        .foregroundStyle(Color.brandForeground)

                    if let date = entry.timestampDate {
                        Text(date.formatted(date: .abbreviated, time: .shortened))
                            .font(.brand(.caption))
                            .foregroundStyle(.tertiary)
                    }
                }

                Spacer()

                // Expand/collapse button
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isExpanded.toggle()
                    }
                } label: {
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("expand-audit-\(entry.id)")
            }

            // Actor
            HStack(spacing: 4) {
                Image(systemName: "person.fill")
                    .font(.caption2)
                Text(entry.actorDisplay)
                    .font(.brandMono(.caption))
            }
            .foregroundStyle(.secondary)

            // Expanded details
            if isExpanded {
                VStack(alignment: .leading, spacing: 6) {
                    // Details
                    if let details = entry.details, !details.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(NSLocalizedString("admin_audit_details", comment: "Details"))
                                .font(.brand(.caption2))
                                .foregroundStyle(.tertiary)
                                .textCase(.uppercase)
                            Text(details)
                                .font(.brand(.caption))
                                .foregroundStyle(.secondary)
                        }
                    }

                    // Hash chain info
                    VStack(alignment: .leading, spacing: 2) {
                        Text(NSLocalizedString("admin_audit_entry_hash", comment: "Entry Hash"))
                            .font(.brand(.caption2))
                            .foregroundStyle(.tertiary)
                            .textCase(.uppercase)

                        Text(entry.truncatedEntryHash)
                            .font(.brandMono(.caption))
                            .foregroundStyle(.secondary)
                    }

                    if let prevHash = entry.previousEntryHash {
                        HStack(spacing: 4) {
                            Image(systemName: "link")
                                .font(.caption2)
                            Text(NSLocalizedString("admin_audit_chained", comment: "Chained to previous"))
                                .font(.brand(.caption2))
                        }
                        .foregroundStyle(.tertiary)
                    }
                }
                .padding(.leading, 28)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Action Styling

    private var actionIcon: String {
        let action = entry.action.lowercased()
        if action.contains("create") || action.contains("add") { return "plus.circle.fill" }
        if action.contains("delete") || action.contains("remove") { return "minus.circle.fill" }
        if action.contains("update") || action.contains("edit") { return "pencil.circle.fill" }
        if action.contains("login") || action.contains("auth") { return "person.badge.key.fill" }
        if action.contains("shift") { return "clock.fill" }
        if action.contains("call") { return "phone.fill" }
        if action.contains("ban") { return "hand.raised.fill" }
        if action.contains("invite") { return "envelope.fill" }
        return "circle.fill"
    }

    private var actionColor: Color {
        let action = entry.action.lowercased()
        if action.contains("create") || action.contains("add") { return Color.statusActive }
        if action.contains("delete") || action.contains("remove") { return Color.brandDestructive }
        if action.contains("update") || action.contains("edit") { return .orange }
        if action.contains("login") || action.contains("auth") { return Color.brandPrimary }
        if action.contains("ban") { return Color.brandDestructive }
        return .secondary
    }
}
