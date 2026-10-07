import SwiftUI

// MARK: - SystemHealthView

/// Admin dashboard view showing system health across 6 categories: Server,
/// Services, Calls, Storage, Backup, and Volunteers. Auto-refreshes every 30 seconds.
struct SystemHealthView: View {
    @Bindable var viewModel: AdminViewModel
    @State private var refreshTimer: Timer?

    var body: some View {
        ScrollView {
            if viewModel.isLoadingHealth && viewModel.systemHealth == nil {
                loadingState
            } else if let health = viewModel.systemHealth {
                healthGrid(health)
            } else {
                errorState
            }
        }
        .navigationTitle(NSLocalizedString("admin_system_health", comment: "System Health"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await viewModel.loadSystemHealth() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.body)
                        .foregroundStyle(Color.brandPrimary)
                }
                .disabled(viewModel.isLoadingHealth)
                .accessibilityIdentifier("health-refresh-button")
                .accessibilityLabel(NSLocalizedString("admin_health_refresh", comment: "Refresh"))
            }
        }
        .task {
            await viewModel.loadSystemHealth()
            startAutoRefresh()
        }
        .onDisappear {
            stopAutoRefresh()
        }
        .accessibilityIdentifier("system-health-view")
    }

    // MARK: - Health Grid

    private func healthGrid(_ health: SystemHealthResponse) -> some View {
        LazyVGrid(
            columns: [
                GridItem(.flexible(), spacing: 12),
                GridItem(.flexible(), spacing: 12),
            ],
            spacing: 12
        ) {
            HealthCardView(
                key: "server",
                icon: "server.rack",
                label: NSLocalizedString("admin_health_server", comment: "Server"),
                status: health.server.status,
                rows: [
                    HealthRow(label: NSLocalizedString("admin_system_uptime", comment: "Uptime"), value: Self.formatUptime(health.server.uptime)),
                    HealthRow(label: NSLocalizedString("admin_system_version", comment: "Version"), value: health.server.version),
                ]
            )

            HealthCardView(
                key: "services",
                icon: "gearshape.2.fill",
                label: NSLocalizedString("admin_health_services", comment: "Services"),
                status: health.services.map(\.status).max { $0.severity < $1.severity },
                rows: health.services.isEmpty
                    ? [HealthRow(label: NSLocalizedString("admin_system_services", comment: "Services"), value: NSLocalizedString("admin_system_no_data", comment: "No data"))]
                    : health.services.map { HealthRow(label: $0.name, value: $0.status.rawValue) }
            )

            HealthCardView(
                key: "calls",
                icon: "phone.fill",
                label: NSLocalizedString("admin_health_calls", comment: "Calls"),
                status: nil,
                rows: [
                    HealthRow(label: NSLocalizedString("admin_system_calls_today", comment: "Calls Today"), value: Self.count(health.calls.today)),
                    HealthRow(label: NSLocalizedString("admin_system_active_calls", comment: "Active Calls"), value: Self.count(health.calls.active)),
                    HealthRow(label: NSLocalizedString("admin_system_avg_response", comment: "Avg Response Time"), value: "\(Self.count(health.calls.avgResponseSeconds))s"),
                    HealthRow(label: NSLocalizedString("admin_system_missed_calls", comment: "Missed Calls"), value: Self.count(health.calls.missed)),
                ]
            )

            HealthCardView(
                key: "storage",
                icon: "internaldrive.fill",
                label: NSLocalizedString("admin_health_storage", comment: "Storage"),
                status: nil,
                rows: [
                    HealthRow(label: NSLocalizedString("admin_system_db_size", comment: "Database Size"), value: health.storage.dbSize),
                    HealthRow(label: NSLocalizedString("admin_system_blob_storage", comment: "Blob Storage"), value: health.storage.blobStorage),
                ]
            )

            HealthCardView(
                key: "backup",
                icon: "arrow.triangle.2.circlepath",
                label: NSLocalizedString("admin_health_backup", comment: "Backup"),
                status: nil,
                rows: [
                    HealthRow(label: NSLocalizedString("admin_system_last_backup", comment: "Last Backup"), value: Self.timestamp(health.backup.lastBackup)),
                    HealthRow(label: NSLocalizedString("admin_system_backup_size", comment: "Backup Size"), value: health.backup.backupSize),
                    HealthRow(label: NSLocalizedString("admin_system_last_verify", comment: "Last Verify"), value: Self.timestamp(health.backup.lastVerify)),
                ]
            )

            HealthCardView(
                key: "volunteers",
                icon: "person.3.fill",
                label: NSLocalizedString("admin_health_users", comment: "Volunteers"),
                status: nil,
                rows: [
                    HealthRow(label: NSLocalizedString("admin_system_total_active", comment: "Total Active"), value: Self.count(health.users.totalActive)),
                    HealthRow(label: NSLocalizedString("admin_system_online_now", comment: "Online Now"), value: Self.count(health.users.onlineNow)),
                    HealthRow(label: NSLocalizedString("admin_system_on_shift", comment: "On Shift"), value: Self.count(health.users.onShift)),
                    HealthRow(label: NSLocalizedString("admin_system_shift_coverage", comment: "Shift Coverage"), value: "\(Self.count(health.users.shiftCoverage))%"),
                ]
            )
        }
        .padding()
    }

    // MARK: - Formatting

    private static func count(_ value: Double) -> String {
        String(Int(value.rounded()))
    }

    private static func formatUptime(_ seconds: Double) -> String {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.day, .hour, .minute]
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        return formatter.string(from: seconds) ?? "-"
    }

    private static func timestamp(_ iso: String?) -> String {
        guard let iso else { return NSLocalizedString("admin_system_never", comment: "Never") }
        guard let date = DateFormatting.parseISO(iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("admin_health_loading", comment: "Loading system health..."))
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
        }
        .frame(maxWidth: .infinity, minHeight: 300)
        .accessibilityIdentifier("health-loading")
    }

    // MARK: - Error State

    private var errorState: some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("admin_health_unavailable", comment: "Health Unavailable"),
                systemImage: "exclamationmark.triangle"
            )
        } description: {
            if let error = viewModel.errorMessage {
                Text(error)
            } else {
                Text(NSLocalizedString(
                    "admin_health_unavailable_message",
                    comment: "Could not load system health data."
                ))
            }
        } actions: {
            Button {
                Task { await viewModel.loadSystemHealth() }
            } label: {
                Text(NSLocalizedString("admin_health_retry", comment: "Retry"))
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("health-retry-button")
        }
        .accessibilityIdentifier("health-error-state")
    }

    // MARK: - Auto-Refresh

    private func startAutoRefresh() {
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
            Task { await viewModel.loadSystemHealth() }
        }
    }

    private func stopAutoRefresh() {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }
}

// MARK: - HealthCardView

/// One label/value line on a health card.
struct HealthRow: Hashable {
    let label: String
    let value: String
}

/// A health card: icon, title, an optional status indicator, and label/value rows.
struct HealthCardView: View {
    /// Stable key for accessibility identifiers (`health-card-<key>`).
    let key: String
    let icon: String
    let label: String
    let status: SharedServiceStatusStatus?
    let rows: [HealthRow]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header
            HStack {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(Color.brandPrimary)

                Spacer()

                if let status {
                    Image(systemName: status.icon)
                        .font(.body)
                        .foregroundStyle(statusColor(status))
                }
            }

            // Label
            Text(label)
                .font(.brand(.headline))
                .foregroundStyle(Color.brandForeground)

            if let status {
                Text(status.rawValue.capitalized)
                    .font(.brand(.subheadline))
                    .fontWeight(.medium)
                    .foregroundStyle(statusColor(status))
                    .accessibilityIdentifier("health-status-\(key)")
            }

            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                HStack(alignment: .firstTextBaseline) {
                    Text(row.label)
                        .foregroundStyle(Color.brandMutedForeground)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(row.value)
                        .foregroundStyle(Color.brandForeground)
                        .lineLimit(1)
                        .accessibilityIdentifier("health-value-\(key)-\(index)")
                }
                .font(.brand(.caption))
            }
        }
        .padding()
        .background(Color.brandCard)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.brandBorder, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("health-card-\(key)")
    }

    private func statusColor(_ status: SharedServiceStatusStatus) -> Color {
        switch status {
        case .ok: return .green
        case .degraded: return .orange
        case .down: return .red
        }
    }
}
