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
                        value: "\(viewModel.users.filter { $0.userRole == .admin }.count)",
                        icon: "shield.fill",
                        color: Color.brandDarkTeal
                    )

                    StatCard(
                        title: NSLocalizedString("admin_active_count", comment: "Active"),
                        value: "\(viewModel.users.filter { $0.userStatus == .active }.count)",
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
                        onRoleChange: { newRole in
                            Task {
                                await viewModel.updateUserRole(
                                    pubkey: user.pubkey,
                                    newRole: newRole
                                )
                            }
                        }
                    )
                    .accessibilityIdentifier("volunteer-row-\(user.id)")
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
    let user: ClientUser
    let onRoleChange: (UserRole) -> Void

    var body: some View {
        HStack(spacing: 12) {
            // Avatar
            Image(systemName: user.userRole == .admin ? "shield.fill" : "person.fill")
                .font(.title3)
                .foregroundStyle(user.userRole == .admin ? Color.brandDarkTeal : Color.brandPrimary)
                .frame(width: 36, height: 36)
                .background(
                    Circle()
                        .fill(
                            (user.userRole == .admin ? Color.brandDarkTeal : Color.brandPrimary)
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
                ForEach(UserRole.allCases, id: \.self) { role in
                    Button {
                        if role != user.userRole {
                            onRoleChange(role)
                        }
                    } label: {
                        HStack {
                            Text(role.displayName)
                            if role == user.userRole {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                roleBadge
            }
            .accessibilityIdentifier("role-menu-\(user.id)")
        }
    }

    // MARK: - Badges

    private var roleBadge: some View {
        Text(user.userRole.displayName)
            .font(.brand(.caption2))
            .fontWeight(.semibold)
            .foregroundStyle(user.userRole == .admin ? Color.brandDarkTeal : Color.brandPrimary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                Capsule()
                    .fill(
                        (user.userRole == .admin ? Color.brandDarkTeal : Color.brandPrimary)
                            .opacity(0.12)
                    )
            )
    }

    private var statusBadge: some View {
        HStack(spacing: 3) {
            Circle()
                .fill(statusColor)
                .frame(width: 6, height: 6)
            Text(user.userStatus.displayName)
                .font(.brand(.caption2))
                .foregroundStyle(.secondary)
        }
    }

    private var statusColor: Color {
        switch user.userStatus {
        case .active: return Color.statusActive
        case .inactive: return .secondary
        case .suspended: return Color.brandDestructive
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
