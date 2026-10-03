import SwiftUI

// MARK: - InviteView

/// Admin view for managing invite codes. Shows existing invites with their
/// status (active/claimed/expired) and allows generating new ones.
struct InviteView: View {
    @Bindable var viewModel: AdminViewModel
    @Environment(HubContext.self) private var hubContext

    var body: some View {
        ZStack {
            if viewModel.isLoadingInvites && viewModel.invites.isEmpty {
                loadingState
            } else if viewModel.invites.isEmpty {
                emptyState
            } else {
                inviteList
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    viewModel.showCreateInviteSheet = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.body)
                        .foregroundStyle(Color.brandPrimary)
                }
                .accessibilityIdentifier("create-invite-button")
                .accessibilityLabel(NSLocalizedString("admin_create_invite", comment: "Create Invite"))
            }
        }
        .sheet(isPresented: $viewModel.showCreateInviteSheet) {
            createInviteSheet
        }
        .refreshable {
            viewModel.isLoadingInvites = false
            await viewModel.loadInvites()
        }
        .task(id: hubContext.activeHubId) {
            await viewModel.loadInvites()
        }
    }

    // MARK: - Invite List

    private var inviteList: some View {
        List {
            // Active invites
            let activeInvites = viewModel.invites.filter { $0.isActive }
            if !activeInvites.isEmpty {
                Section {
                    ForEach(activeInvites) { invite in
                        InviteRowView(invite: invite)
                            .accessibilityIdentifier("invite-row-\(invite.id)")
                    }
                } header: {
                    Text(L10n.format(
                        "admin_active_invites_header",
                        comment: "Active (%d)",
                        activeInvites.count
                    ))
                }
            }

            // Claimed invites
            let claimedInvites = viewModel.invites.filter { $0.isClaimed }
            if !claimedInvites.isEmpty {
                Section {
                    ForEach(claimedInvites) { invite in
                        InviteRowView(invite: invite)
                            .accessibilityIdentifier("invite-row-\(invite.id)")
                    }
                } header: {
                    Text(L10n.format(
                        "admin_claimed_invites_header",
                        comment: "Claimed (%d)",
                        claimedInvites.count
                    ))
                }
            }

            // Expired invites
            let expiredInvites = viewModel.invites.filter { !$0.isClaimed && $0.isExpired }
            if !expiredInvites.isEmpty {
                Section {
                    ForEach(expiredInvites) { invite in
                        InviteRowView(invite: invite)
                            .accessibilityIdentifier("invite-row-\(invite.id)")
                    }
                } header: {
                    Text(L10n.format(
                        "admin_expired_invites_header",
                        comment: "Expired (%d)",
                        expiredInvites.count
                    ))
                }
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("invites-list")
    }

    // MARK: - Create Invite Sheet

    private var createInviteSheet: some View {
        NavigationStack {
            Form {
                Section {
                    Picker(
                        NSLocalizedString("admin_invite_role", comment: "Role"),
                        selection: $viewModel.newInviteRole
                    ) {
                        ForEach(UserRole.allCases, id: \.self) { role in
                            Text(role.displayName).tag(role)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("invite-role-picker")
                } header: {
                    Text(NSLocalizedString("admin_invite_role_header", comment: "Invite Role"))
                } footer: {
                    Text(NSLocalizedString(
                        "admin_invite_role_footer",
                        comment: "Choose the role for the person being invited. Admins have full management access."
                    ))
                    .font(.brand(.caption))
                }

                if let error = viewModel.errorMessage {
                    Section {
                        Text(error)
                            .font(.brand(.footnote))
                            .foregroundStyle(Color.brandDestructive)
                    }
                }
            }
            .navigationTitle(NSLocalizedString("admin_create_invite_title", comment: "Create Invite"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        viewModel.showCreateInviteSheet = false
                    }
                    .accessibilityIdentifier("cancel-create-invite")
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("admin_generate_invite", comment: "Generate")) {
                        Task { await viewModel.createInvite() }
                    }
                    .fontWeight(.semibold)
                    .accessibilityIdentifier("submit-create-invite")
                }
            }
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("admin_no_invites", comment: "No Invites"),
                systemImage: "envelope.open"
            )
        } description: {
            Text(NSLocalizedString(
                "admin_no_invites_message",
                comment: "Generate invite codes to add new volunteers."
            ))
        } actions: {
            Button {
                viewModel.showCreateInviteSheet = true
            } label: {
                Text(NSLocalizedString("admin_create_first_invite", comment: "Create First Invite"))
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("create-first-invite")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("invites-empty-state")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("admin_loading_invites", comment: "Loading invites..."))
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("invites-loading")
    }
}

// MARK: - InviteRowView

/// A single invite row showing the code, role, status, and sharing option.
struct InviteRowView: View {
    let invite: AppInvite

    @State private var showCopied: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Code and share button
            HStack {
                Text(invite.code)
                    .font(.brandMono(.body))
                    .fontWeight(.medium)
                    .foregroundStyle(Color.brandForeground)
                    .lineLimit(1)

                Spacer()

                if invite.isActive {
                    Button {
                        UIPasteboard.general.string = invite.code
                        showCopyFeedback()
                    } label: {
                        if showCopied {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(Color.statusActive)
                        } else {
                            Image(systemName: "doc.on.doc")
                                .foregroundStyle(Color.brandPrimary)
                        }
                    }
                    .font(.caption)
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("copy-invite-\(invite.id)")
                    .accessibilityLabel(NSLocalizedString("admin_copy_invite", comment: "Copy invite code"))
                }
            }

            // Status badges
            HStack(spacing: 8) {
                // Role badge
                Text(invite.inviteRole.displayName)
                    .font(.brand(.caption2))
                    .fontWeight(.medium)
                    .foregroundStyle(invite.inviteRole == .admin ? Color.brandDarkTeal : Color.brandPrimary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        Capsule()
                            .fill(
                                (invite.inviteRole == .admin ? Color.brandDarkTeal : Color.brandPrimary)
                                    .opacity(0.12)
                            )
                    )

                // Status badge
                statusBadge

                Spacer()

                // Expiry
                if let expiresDate = invite.expiresDate {
                    Text(expiresDate.formatted(date: .abbreviated, time: .shortened))
                        .font(.brand(.caption2))
                        .foregroundStyle(.tertiary)
                }
            }

            // Creator info
            HStack(spacing: 4) {
                Image(systemName: "person.fill")
                    .font(.caption2)
                Text(invite.creatorDisplay)
                    .font(.brandMono(.caption2))
            }
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Status Badge

    private var statusBadge: some View {
        Group {
            if invite.isClaimed {
                HStack(spacing: 3) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.caption2)
                    Text(NSLocalizedString("admin_invite_claimed", comment: "Claimed"))
                        .font(.brand(.caption2))
                        .fontWeight(.medium)
                }
                .foregroundStyle(Color.statusActive)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.statusActive.opacity(0.12)))
            } else if invite.isExpired {
                HStack(spacing: 3) {
                    Image(systemName: "clock.badge.exclamationmark")
                        .font(.caption2)
                    Text(NSLocalizedString("admin_invite_expired", comment: "Expired"))
                        .font(.brand(.caption2))
                        .fontWeight(.medium)
                }
                .foregroundStyle(Color.brandDestructive)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.brandDestructive.opacity(0.12)))
            } else {
                HStack(spacing: 3) {
                    Image(systemName: "circle.fill")
                        .font(.system(size: 6))
                    Text(NSLocalizedString("admin_invite_active", comment: "Active"))
                        .font(.brand(.caption2))
                        .fontWeight(.medium)
                }
                .foregroundStyle(.orange)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.orange.opacity(0.12)))
            }
        }
    }

    // MARK: - Copy Feedback

    private func showCopyFeedback() {
        let generator = UINotificationFeedbackGenerator()
        generator.notificationOccurred(.success)

        withAnimation(.easeInOut(duration: 0.2)) {
            showCopied = true
        }

        Task {
            try? await Task.sleep(for: .seconds(2))
            withAnimation(.easeInOut(duration: 0.2)) {
                showCopied = false
            }
        }
    }
}
