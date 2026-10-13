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
                status: Self.serverStatus(health.server),
                icon: "server.rack",
                label: NSLocalizedString("admin_health_server", comment: "Server")
            )
            .accessibilityIdentifier("health-card-server")

            HealthCardView(
                status: Self.servicesStatus(health.services),
                icon: "gearshape.2.fill",
                label: NSLocalizedString("admin_health_services", comment: "Services")
            )
            .accessibilityIdentifier("health-card-services")

            HealthCardView(
                status: Self.callsStatus(health.calls),
                icon: "phone.fill",
                label: NSLocalizedString("admin_health_calls", comment: "Calls")
            )
            .accessibilityIdentifier("health-card-calls")

            HealthCardView(
                status: Self.storageStatus(health.storage),
                icon: "internaldrive.fill",
                label: NSLocalizedString("admin_health_storage", comment: "Storage")
            )
            .accessibilityIdentifier("health-card-storage")

            HealthCardView(
                status: Self.backupStatus(health.backup),
                icon: "arrow.triangle.2.circlepath",
                label: NSLocalizedString("admin_health_backup", comment: "Backup")
            )
            .accessibilityIdentifier("health-card-backup")

            HealthCardView(
                status: Self.volunteersStatus(health.users),
                icon: "person.3.fill",
                label: NSLocalizedString("admin_health_users", comment: "Volunteers")
            )
            .accessibilityIdentifier("health-card-volunteers")
        }
        .padding()
    }

    // MARK: - Response Mapping

    static func serverStatus(_ server: Server) -> ServiceHealthStatus {
        ServiceHealthStatus(
            name: "Server",
            status: server.status.rawValue,
            details: "v\(server.version) · up \(formatUptime(server.uptime))"
        )
    }

    static func servicesStatus(_ services: [SystemHealthResponseService]) -> ServiceHealthStatus {
        let worst = services.contains(where: { $0.status == .down }) ? "down"
            : services.contains(where: { $0.status == .degraded }) ? "degraded"
            : "ok"
        let healthy = services.filter { $0.status == .ok }.count
        let degradedNames = services.filter { $0.status != .ok }.map(\.name)
        let details = degradedNames.isEmpty
            ? "\(healthy)/\(services.count) healthy"
            : degradedNames.joined(separator: ", ")
        return ServiceHealthStatus(name: "Services", status: worst, details: details)
    }

    static func callsStatus(_ calls: Calls) -> ServiceHealthStatus {
        ServiceHealthStatus(
            name: "Calls",
            status: "ok",
            details: "\(Int(calls.today)) today · \(Int(calls.active)) active · \(Int(calls.missed)) missed"
        )
    }

    static func storageStatus(_ storage: Storage) -> ServiceHealthStatus {
        ServiceHealthStatus(
            name: "Storage",
            status: "ok",
            details: "DB \(storage.dbSize) · Blob \(storage.blobStorage)"
        )
    }

    static func backupStatus(_ backup: Backup) -> ServiceHealthStatus {
        ServiceHealthStatus(
            name: "Backup",
            status: backup.lastBackup == nil ? "degraded" : "ok",
            details: backup.lastBackup.map { "Last: \($0)" } ?? "No backup yet"
        )
    }

    static func volunteersStatus(_ users: Users) -> ServiceHealthStatus {
        ServiceHealthStatus(
            name: "Volunteers",
            status: "ok",
            details: "\(Int(users.onShift)) on shift · \(Int(users.totalActive)) active · \(Int(users.onlineNow)) online"
        )
    }

    static func formatUptime(_ seconds: Double) -> String {
        let total = Int(seconds)
        let days = total / 86400
        let hours = (total % 86400) / 3600
        let minutes = (total % 3600) / 60
        if days > 0 { return "\(days)d \(hours)h" }
        if hours > 0 { return "\(hours)h \(minutes)m" }
        return "\(minutes)m"
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

/// A single health status card showing an icon, label, status indicator, and details.
struct HealthCardView: View {
    let status: ServiceHealthStatus
    let icon: String
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header
            HStack {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(Color.brandPrimary)

                Spacer()

                // Status indicator
                Image(systemName: status.healthLevel.icon)
                    .font(.body)
                    .foregroundStyle(statusColor)
            }

            // Label
            Text(label)
                .font(.brand(.headline))
                .foregroundStyle(Color.brandForeground)

            // Status text
            Text(status.status.capitalized)
                .font(.brand(.subheadline))
                .fontWeight(.medium)
                .foregroundStyle(statusColor)

            // Details
            if let details = status.details, !details.isEmpty {
                Text(details)
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
                    .lineLimit(2)
            }
        }
        .padding()
        .background(Color.brandCard)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.brandBorder, lineWidth: 1)
        )
    }

    private var statusColor: Color {
        switch status.healthLevel {
        case .healthy: return .green
        case .degraded: return .orange
        case .critical: return .red
        }
    }
}
