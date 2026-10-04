import SwiftUI

// MARK: - HubManagementView

/// Lists hubs the user belongs to. Active hub is highlighted with a checkmark.
/// Admins can create new hubs. Tapping a hub switches the active context.
struct HubManagementView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModelBox = ViewModelBox<HubManagementViewModel>()
    @State private var showCreateHub: Bool = false

    private var vm: HubManagementViewModel {
        if let existing = viewModelBox.value { return existing }
        let vm = HubManagementViewModel(
            apiService: appState.apiService,
            cryptoService: appState.cryptoService,
            hubContext: appState.hubContext
        )
        viewModelBox.value = vm
        return vm
    }

    var body: some View {
        let vm = self.vm

        Group {
            if vm.isLoading && vm.hubs.isEmpty {
                loadingView
            } else if vm.hubs.isEmpty {
                emptyStateView
            } else {
                hubListView(vm: vm)
            }
        }
        .navigationTitle(NSLocalizedString("hubs_title", comment: "Hubs"))
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            if appState.hasPermission("hubs:read") {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showCreateHub = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityIdentifier("hubs-create-btn")
                }
            }
        }
        .sheet(isPresented: $showCreateHub) {
            CreateHubView(viewModel: vm) {
                showCreateHub = false
            }
        }
        .task {
            await vm.loadHubs()
        }
        .refreshable {
            await vm.loadHubs()
        }
        .alert(
            NSLocalizedString("common_error", comment: "Error"),
            isPresented: .constant(vm.error != nil)
        ) {
            Button(NSLocalizedString("common_ok", comment: "OK")) {
                vm.error = nil
            }
        } message: {
            if let msg = vm.errorMessage {
                Text(msg)
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
        .accessibilityIdentifier("hubs-loading")
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        BrandEmptyState(
            icon: "building.2",
            title: NSLocalizedString("hubs_empty_title", comment: "No Hubs"),
            message: NSLocalizedString("hubs_empty_message", comment: "You are not a member of any hubs yet."),
            action: appState.hasPermission("hubs:read") ? { showCreateHub = true } : nil,
            actionLabel: appState.hasPermission("hubs:read")
                ? NSLocalizedString("hubs_create_hub", comment: "Create Hub")
                : nil,
            actionAccessibilityID: "hubs-empty-create-btn"
        )
    }

    // MARK: - Hub List

    private func hubListView(vm: HubManagementViewModel) -> some View {
        List {
            Section {
                ForEach(vm.hubs) { hub in
                    HubRow(
                        hub: hub,
                        isActive: vm.isActive(hub),
                        onTap: {
                            Task { await vm.switchHub(to: hub) }
                        }
                    )
                }
            } header: {
                Text(NSLocalizedString("hubs_your_hubs", comment: "Your Hubs"))
            } footer: {
                Text(NSLocalizedString(
                    "hubs_switch_footer",
                    comment: "Tap a hub to switch your active context. The active hub determines which data you see."
                ))
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("hubs-list")
    }
}

// MARK: - HubRow

private struct HubRow: View {
    let hub: SharedHub
    let isActive: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                // Hub icon
                ZStack {
                    Circle()
                        .fill(statusColor.opacity(0.15))
                        .frame(width: 40, height: 40)
                    Image(systemName: "building.2.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(statusColor)
                }

                // Hub details
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(hub.name)
                            .font(.brand(.body))
                            .fontWeight(.medium)
                            .foregroundStyle(Color.brandForeground)

                        Text("/\(hub.slug)")
                            .font(.brandMono(.caption))
                            .foregroundStyle(Color.brandMutedForeground)
                    }

                    HStack(spacing: 8) {
                        BadgeView(
                            text: hub.status.displayName,
                            icon: nil,
                            color: statusSwiftUIColor,
                            style: .subtle
                        )

                        if let phone = hub.phoneNumber, !phone.isEmpty {
                            HStack(spacing: 2) {
                                Image(systemName: "phone.fill")
                                    .font(.system(size: 9))
                                Text(phone)
                                    .font(.brandMono(.caption2))
                            }
                            .foregroundStyle(Color.brandMutedForeground)
                        }
                    }

                    if let description = hub.description, !description.isEmpty {
                        Text(description)
                            .font(.brand(.caption))
                            .foregroundStyle(Color.brandMutedForeground)
                            .lineLimit(1)
                    }
                }

                Spacer()

                // Active indicator
                if isActive {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(Color.brandPrimary)
                        .accessibilityLabel(
                            NSLocalizedString("hubs_active", comment: "Active hub")
                        )
                }
            }
            .padding(.vertical, 4)
        }
        .accessibilityIdentifier("hub-row-\(hub.slug)")
        // The checkmark's "Active" label is indistinguishable from the status badge's
        // "Active"; the selected trait is what says which hub is the active one.
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    private var statusColor: Color {
        switch hub.status {
        case .active: return .green
        case .suspended: return .yellow
        case .archived: return .red
        }
    }

    private var statusSwiftUIColor: Color {
        switch hub.status {
        case .active: return .green
        case .suspended: return .orange
        case .archived: return .red
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Hub Management") {
    NavigationStack {
        HubManagementView()
            .environment(AppState(hubContext: HubContext()))
    }
}
#endif
