import SwiftUI

// MARK: - RolesView

/// Read-only role viewer: hub roles with effective permissions and
/// assigned-user counts, mirroring the desktop hub-roles-section / role-list.
/// Role CRUD stays on desktop; this surface is the viewer of record on mobile.
struct RolesView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModelBox = ViewModelBox<RolesViewModel>()

    var body: some View {
        let vm = resolvedViewModel

        ZStack {
            if vm.isLoading && vm.roles.isEmpty {
                ProgressView()
                    .accessibilityIdentifier("roles-loading")
            } else if let error = vm.errorMessage, vm.roles.isEmpty {
                ContentUnavailableView {
                    Label(
                        NSLocalizedString("contacts_error_title", comment: "Unable to Load"),
                        systemImage: "exclamationmark.triangle"
                    )
                } description: {
                    Text(error)
                } actions: {
                    Button {
                        Task { await reload(vm) }
                    } label: {
                        Text(NSLocalizedString("retry", comment: "Retry"))
                    }
                    .buttonStyle(.bordered)
                }
                .accessibilityIdentifier("roles-error")
            } else {
                List {
                    ForEach(vm.roles) { role in
                        NavigationLink {
                            RoleDetailView(role: role, viewModel: vm)
                        } label: {
                            RoleRowView(role: role)
                        }
                        .accessibilityIdentifier("role-row-\(role.slug)")
                    }
                }
                .accessibilityIdentifier("roles-list")
            }
        }
        .navigationTitle(NSLocalizedString("roles_title", comment: "Roles & Permissions"))
        .navigationBarTitleDisplayMode(.large)
        .refreshable {
            await reload(vm)
        }
        .task {
            await vm.loadRoles(includeCatalog: appState.hasPermission("system:manage-roles"))
        }
    }

    private func reload(_ vm: RolesViewModel) async {
        vm.isLoading = false
        await vm.loadRoles(includeCatalog: appState.hasPermission("system:manage-roles"))
    }

    private var resolvedViewModel: RolesViewModel {
        if let existing = viewModelBox.value { return existing }
        let vm = RolesViewModel(
            rolesAPI: RolesAPIService(apiService: appState.apiService),
            cryptoService: appState.cryptoService
        )
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - RoleRowView

struct RoleRowView: View {
    let role: DecryptedRole

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(role.name)
                    .font(.brand(.body))
                    .fontWeight(.medium)
                    .foregroundStyle(Color.brandForeground)
                    .lineLimit(1)

                if role.isSystem {
                    badge(NSLocalizedString("roles_system", comment: "System"), icon: "lock.fill")
                        .accessibilityIdentifier("role-system-badge-\(role.slug)")
                } else if role.isDefault {
                    badge(NSLocalizedString("roles_default", comment: "Default"), icon: nil)
                        .accessibilityIdentifier("role-default-badge-\(role.slug)")
                }
            }

            if !role.roleDescription.isEmpty {
                Text(role.roleDescription)
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
                    .lineLimit(2)
            }

            HStack(spacing: 8) {
                Text(permissionCountText)
                    .font(.brand(.caption2))
                    .foregroundStyle(Color.brandMutedForeground)
                    .accessibilityIdentifier("role-permission-count-\(role.slug)")
                if let count = role.assignedUserCount {
                    Text(userCountText(count))
                        .font(.brand(.caption2))
                        .foregroundStyle(Color.brandMutedForeground)
                        .accessibilityIdentifier("role-user-count-\(role.slug)")
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var permissionCountText: String {
        if role.permissions.count == 1 && role.permissions[0] == "*" {
            return NSLocalizedString("roles_all_permissions", comment: "All permissions")
        }
        if role.permissions.count == 1 {
            return NSLocalizedString("roles_permission_count_one", comment: "1 permission")
        }
        return L10n.format("roles_permission_count", role.permissions.count)
    }

    private func userCountText(_ count: Int) -> String {
        if count == 1 {
            return NSLocalizedString("roles_assigned_users_one", comment: "1 user")
        }
        return L10n.format("roles_assigned_users", count)
    }

    private func badge(_ text: String, icon: String?) -> some View {
        HStack(spacing: 3) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 8))
            }
            Text(text)
                .font(.brand(.caption2))
        }
        .foregroundStyle(Color.brandDarkTeal)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(Color.brandDarkTeal.opacity(0.12)))
    }
}

// MARK: - RoleDetailView

/// Effective permissions for one role, grouped by permission domain.
struct RoleDetailView: View {
    let role: DecryptedRole
    let viewModel: RolesViewModel

    var body: some View {
        List {
            Section {
                LabeledContent(
                    NSLocalizedString("roles_slug", comment: "Slug"),
                    value: role.slug
                )
                if let count = role.assignedUserCount {
                    LabeledContent(
                        NSLocalizedString("roles_users_label", comment: "Users"),
                        value: "\(count)"
                    )
                }
            }

            Section(NSLocalizedString("roles_permissions", comment: "Permissions")) {
                if role.permissions.isEmpty {
                    Text(NSLocalizedString("roles_no_permissions", comment: "No permissions assigned"))
                        .foregroundStyle(Color.brandMutedForeground)
                } else {
                    ForEach(role.permissionsByDomain, id: \.domain) { group in
                        DisclosureGroup {
                            ForEach(group.keys, id: \.self) { key in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(viewModel.label(for: key))
                                        .font(.brand(.subheadline))
                                        .foregroundStyle(Color.brandForeground)
                                    Text(key)
                                        .font(.brandMono(.caption2))
                                        .foregroundStyle(Color.brandMutedForeground)
                                }
                            }
                        } label: {
                            Text(group.domain)
                                .font(.brand(.subheadline))
                                .fontWeight(.medium)
                        }
                        .accessibilityIdentifier("role-domain-\(group.domain)")
                    }
                }
            }
        }
        .navigationTitle(role.name)
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("role-detail")
    }
}

// MARK: - EffectivePermissionsView

/// A member's effective permissions (union of their role assignments),
/// from GET /api/settings/users/:id/effective-permissions. Admin-gated
/// (users:read) by the caller.
struct EffectivePermissionsView: View {
    @Environment(AppState.self) private var appState
    @State var viewModel: EffectivePermissionsViewModel

    let displayName: String

    var body: some View {
        ZStack {
            if viewModel.isLoading && viewModel.permissions.isEmpty {
                ProgressView()
                    .accessibilityIdentifier("effective-permissions-loading")
            } else if let error = viewModel.errorMessage {
                ContentUnavailableView {
                    Label(
                        NSLocalizedString("contacts_error_title", comment: "Unable to Load"),
                        systemImage: "exclamationmark.triangle"
                    )
                } description: {
                    Text(error)
                }
                .accessibilityIdentifier("effective-permissions-error")
            } else {
                List {
                    Section {
                        Text(NSLocalizedString(
                            "roles_effective_permissions_description",
                            comment: "All permissions this member holds through their role assignments."
                        ))
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                    }

                    if viewModel.permissions.isEmpty {
                        Section {
                            Text(NSLocalizedString("roles_no_permissions", comment: "No permissions assigned"))
                                .foregroundStyle(Color.brandMutedForeground)
                        }
                    } else {
                        ForEach(viewModel.permissionsByDomain, id: \.domain) { group in
                            Section(group.domain) {
                                ForEach(group.keys, id: \.self) { key in
                                    Text(key)
                                        .font(.brandMono(.caption))
                                        .foregroundStyle(Color.brandForeground)
                                }
                            }
                            .accessibilityIdentifier("effective-domain-\(group.domain)")
                        }
                    }
                }
                .accessibilityIdentifier("effective-permissions-list")
            }
        }
        .navigationTitle(NSLocalizedString("roles_effective_permissions", comment: "Effective Permissions"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.load(hubId: appState.hubContext.activeHubId)
        }
    }
}
