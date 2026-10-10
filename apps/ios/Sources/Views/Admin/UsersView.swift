import SwiftUI

// MARK: - UsersView

/// Admin view for managing users. Shows a searchable list of all members
/// with role badges and allows role updates.
struct UsersView: View {
    @Bindable var viewModel: AdminViewModel
    @Environment(HubContext.self) private var hubContext

    var body: some View {
        ZStack {
            if viewModel.isLoadingUsers && viewModel.users.isEmpty {
                loadingState
            } else if viewModel.filteredUsers.isEmpty {
                emptyState
            } else {
                usersList
            }
        }
        .searchable(
            text: $viewModel.userSearchText,
            placement: .navigationBarDrawer(displayMode: .automatic),
            prompt: NSLocalizedString("admin_search_users", comment: "Search volunteers...")
        )
        .refreshable {
            viewModel.isLoadingUsers = false
            await viewModel.loadUsers()
        }
        .task(id: hubContext.activeHubId) {
            await viewModel.loadUsers()
            await viewModel.loadRoles()
        }
    }

    // MARK: - Users List

    private var usersList: some View {
        List {
            // Stats header
            Section {
                HStack {
                    StatCard(
                        title: NSLocalizedString("admin_total_members", comment: "Total"),
                        value: "\(viewModel.users.count)",
                        icon: "person.3.fill",
                        color: Color.brandPrimary
                    )

                    StatCard(
                        title: NSLocalizedString("admin_admin_count", comment: "Admins"),
                        value: "\(viewModel.users.filter { $0.isAdmin }.count)",
                        icon: "shield.fill",
                        color: Color.brandDarkTeal
                    )

                    StatCard(
                        title: NSLocalizedString("admin_active_count", comment: "Active"),
                        value: "\(viewModel.users.filter { $0.active }.count)",
                        icon: "checkmark.circle.fill",
                        color: Color.statusActive
                    )
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }

            // Members list
            Section {
                ForEach(viewModel.filteredUsers) { user in
                    UserRowView(
                        user: user,
                        roles: viewModel.roles,
                        onRoleChange: { newRoleId in
                            Task {
                                await viewModel.updateUserRole(
                                    pubkey: user.pubkey,
                                    newRoleId: newRoleId
                                )
                            }
                        }
                    )
                    .accessibilityIdentifier("volunteer-row-\(user.pubkey)")
                }
            } header: {
                Text(L10n.format(
                    "admin_members_header",
                    comment: "Members (%d)",
                    viewModel.filteredUsers.count
                ))
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("volunteers-list")
    }

    // MARK: - Empty State

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("admin_no_users", comment: "No Volunteers"),
                systemImage: "person.3"
            )
        } description: {
            if viewModel.userSearchText.isEmpty {
                Text(NSLocalizedString(
                    "admin_no_users_message",
                    comment: "No members have joined yet."
                ))
            } else {
                Text(NSLocalizedString(
                    "admin_no_search_results",
                    comment: "No members match your search."
                ))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("volunteers-empty-state")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("admin_loading_users", comment: "Loading members..."))
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("volunteers-loading")
    }
}

// MARK: - UserRowView

/// A single user row showing display name, pubkey, role badge, and status.
struct UserRowView: View {
    let user: UserListResponseUser
    /// Roles offered in the role menu (`GET /api/settings/roles`). When the
    /// list has not loaded, the built-in volunteer/admin pair is offered.
    let roles: [RoleListResponseRole]
    let onRoleChange: (String) -> Void

    /// The role choices the menu shows: the server's roles, or the two
    /// built-ins when the roles list is unavailable.
    private var roleChoices: [(id: String, label: String)] {
        if roles.isEmpty {
            return [
                ("role-volunteer", NSLocalizedString("users_role_volunteer", comment: "Volunteer")),
                ("role-super-admin", NSLocalizedString("users_role_admin", comment: "Admin")),
            ]
        }
        return roles.map { ($0.id, $0.name ?? $0.slug) }
    }

    private var currentRoleLabel: String {
        if let current = user.primaryRoleId,
           let role = roles.first(where: { $0.id == current }) {
            return role.name ?? role.slug
        }
        return user.isAdmin
            ? NSLocalizedString("users_role_admin", comment: "Admin")
            : NSLocalizedString("users_role_volunteer", comment: "Volunteer")
    }

    var body: some View {
        HStack(spacing: 12) {
            // Avatar
            Image(systemName: user.isAdmin ? "shield.fill" : "person.fill")
                .font(.title3)
                .foregroundStyle(user.isAdmin ? Color.brandDarkTeal : Color.brandPrimary)
                .frame(width: 36, height: 36)
                .background(
                    Circle()
                        .fill(
                            (user.isAdmin ? Color.brandDarkTeal : Color.brandPrimary)
                                .opacity(0.12)
                        )
                )

            // Info
            VStack(alignment: .leading, spacing: 4) {
                Text(user.displayLabel)
                    .font(.brand(.body))
                    .fontWeight(.medium)
                    .foregroundStyle(Color.brandForeground)
                    .lineLimit(1)

                HStack(spacing: 6) {
                    Text(user.truncatedPubkey)
                        .font(.brandMono(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                        .lineLimit(1)

                    statusBadge
                }
            }

            Spacer()

            // Role menu
            Menu {
                ForEach(roleChoices, id: \.id) { choice in
                    Button {
                        if choice.id != user.primaryRoleId {
                            onRoleChange(choice.id)
                        }
                    } label: {
                        HStack {
                            Text(choice.label)
                            if choice.id == user.primaryRoleId {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                roleBadge
            }
            .accessibilityIdentifier("role-menu-\(user.pubkey)")
        }
    }

    // MARK: - Badges

    private var roleBadge: some View {
        Text(currentRoleLabel)
            .font(.brand(.caption2))
            .fontWeight(.semibold)
            .foregroundStyle(user.isAdmin ? Color.brandDarkTeal : Color.brandPrimary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                Capsule()
                    .fill(
                        (user.isAdmin ? Color.brandDarkTeal : Color.brandPrimary)
                            .opacity(0.12)
                    )
            )
    }

    private var statusBadge: some View {
        HStack(spacing: 3) {
            Circle()
                .fill(user.active ? Color.statusActive : Color.secondary)
                .frame(width: 6, height: 6)
            Text(user.active
                 ? NSLocalizedString("status_active", comment: "Active")
                 : NSLocalizedString("status_inactive", comment: "Inactive"))
                .font(.brand(.caption2))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - StatCard

/// A compact stat display card used in the users header.
struct StatCard: View {
    let title: String
    let value: String
    let icon: String
    let color: Color

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(color)
            Text(value)
                .font(.brand(.title3))
                .fontWeight(.bold)
                .foregroundStyle(Color.brandForeground)
            Text(title)
                .font(.brand(.caption2))
                .foregroundStyle(Color.brandMutedForeground)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.brandCard)
        )
    }
}
