import SwiftUI

// MARK: - ShiftAdminView

/// Admin hub for shift management: ring groups, the fallback group, shift
/// overrides, and join/leave request review. Reached from the Shifts tab's
/// Manage button, which is itself permission-gated; each row here is gated
/// again so an admin holding only some of the shift permissions sees exactly
/// the surfaces they can use.
struct ShiftAdminView: View {
    @Environment(AppState.self) private var appState
    @Environment(HubContext.self) private var hubContext
    @State private var viewModelBox = ViewModelBox<ShiftAdminViewModel>()

    var body: some View {
        let vm = resolvedViewModel

        List {
            if appState.hasPermission("shifts:manage-ring-groups") {
                NavigationLink {
                    RingGroupsView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("shifts_ring_groups_title", comment: "Ring Groups"),
                        systemImage: "person.3.sequence.fill"
                    )
                }
                .accessibilityIdentifier("shift-admin-ring-groups-link")
            }

            if appState.hasPermission("shifts:manage-fallback") {
                NavigationLink {
                    FallbackGroupView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("shifts_fallback_group", comment: "Fallback Group"),
                        systemImage: "lifepreserver"
                    )
                }
                .accessibilityIdentifier("shift-admin-fallback-link")
            }

            if appState.hasPermission("shifts:manage-overrides") {
                NavigationLink {
                    ShiftOverridesView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("shifts_overrides_title", comment: "Shift Overrides"),
                        systemImage: "calendar.badge.exclamationmark"
                    )
                }
                .accessibilityIdentifier("shift-admin-overrides-link")
            }

            if appState.hasPermission("shifts:approve-requests") {
                NavigationLink {
                    ShiftRequestsView(viewModel: vm)
                } label: {
                    Label(
                        NSLocalizedString("shifts_requests_title", comment: "Shift Requests"),
                        systemImage: "checkmark.shield.fill"
                    )
                }
                .accessibilityIdentifier("shift-admin-requests-link")
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(NSLocalizedString("shifts_manage", comment: "Manage"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("shift-admin-view")
    }

    private var resolvedViewModel: ShiftAdminViewModel {
        if let vm = viewModelBox.value {
            return vm
        }
        let vm = ShiftAdminViewModel(apiService: appState.apiService, hubContext: hubContext)
        viewModelBox.value = vm
        return vm
    }
}
