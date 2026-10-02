import SwiftUI

// MARK: - BanListView

/// Admin view for managing the ban list. Shows banned identifier hashes
/// with reasons and allows adding/removing bans.
struct BanListView: View {
    @Bindable var viewModel: AdminViewModel
    @Environment(HubContext.self) private var hubContext

    var body: some View {
        ZStack {
            if viewModel.isLoadingBans && viewModel.bans.isEmpty {
                loadingState
            } else if viewModel.bans.isEmpty {
                emptyState
            } else {
                banList
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    viewModel.showAddBanSheet = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.body)
                        .foregroundStyle(Color.brandPrimary)
                }
                .accessibilityIdentifier("add-ban-button")
                .accessibilityLabel(NSLocalizedString("admin_add_ban", comment: "Add Ban"))
            }
        }
        .sheet(isPresented: $viewModel.showAddBanSheet) {
            addBanSheet
        }
        .refreshable {
            viewModel.isLoadingBans = false
            await viewModel.loadBans()
        }
        .task(id: hubContext.activeHubId) {
            await viewModel.loadBans()
        }
    }

    // MARK: - Ban List

    private var banList: some View {
        List {
            Section {
                ForEach(viewModel.bans) { ban in
                    BanRowView(ban: ban) {
                        viewModel.confirmDelete(id: ban.id, type: .ban)
                    }
                    .accessibilityIdentifier("ban-row-\(ban.id)")
                }
            } header: {
                Text(L10n.format(
                    "admin_bans_header",
                    comment: "Banned (%d)",
                    viewModel.bans.count
                ))
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("ban-list")
    }

    // MARK: - Add Ban Sheet

    private var addBanSheet: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(NSLocalizedString("admin_ban_hash_label", comment: "Identifier Hash"))
                            .font(.brand(.caption))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)

                        TextField(
                            NSLocalizedString("admin_ban_hash_placeholder", comment: "SHA-256 hash of phone number or identifier"),
                            text: $viewModel.newBanIdentifierHash
                        )
                        .font(.brandMono(.body))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityIdentifier("ban-hash-input")
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text(NSLocalizedString("admin_ban_reason_label", comment: "Reason (Optional)"))
                            .font(.brand(.caption))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)

                        TextField(
                            NSLocalizedString("admin_ban_reason_placeholder", comment: "Reason for ban"),
                            text: $viewModel.newBanReason,
                            axis: .vertical
                        )
                        .lineLimit(2...4)
                        .accessibilityIdentifier("ban-reason-input")
                    }
                } header: {
                    Text(NSLocalizedString("admin_new_ban_header", comment: "New Ban Entry"))
                } footer: {
                    Text(NSLocalizedString(
                        "admin_ban_footer",
                        comment: "Enter the SHA-256 hash of the caller's phone number or identifier to ban."
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
            .navigationTitle(NSLocalizedString("admin_add_ban_title", comment: "Add Ban"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        viewModel.newBanIdentifierHash = ""
                        viewModel.newBanReason = ""
                        viewModel.showAddBanSheet = false
                    }
                    .accessibilityIdentifier("cancel-add-ban")
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("admin_ban_submit", comment: "Add Ban")) {
                        Task { await viewModel.addBan() }
                    }
                    .fontWeight(.semibold)
                    .disabled(
                        viewModel.newBanIdentifierHash
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                            .isEmpty
                    )
                    .accessibilityIdentifier("submit-add-ban")
                }
            }
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("admin_no_bans", comment: "No Bans"),
                systemImage: "hand.raised"
            )
        } description: {
            Text(NSLocalizedString(
                "admin_no_bans_message",
                comment: "No identifiers are currently banned."
            ))
        } actions: {
            Button {
                viewModel.showAddBanSheet = true
            } label: {
                Text(NSLocalizedString("admin_add_first_ban", comment: "Add First Ban"))
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("add-first-ban")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("bans-empty-state")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("admin_loading_bans", comment: "Loading ban list..."))
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("bans-loading")
    }
}

// MARK: - BanRowView

/// A single ban entry row showing the identifier hash, reason, creator, and date.
struct BanRowView: View {
    let ban: AppBanEntry
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Hash
            HStack {
                Image(systemName: "number")
                    .font(.caption)
                    .foregroundStyle(Color.brandDestructive)

                Text(ban.truncatedHash)
                    .font(.brandMono(.body))
                    .foregroundStyle(Color.brandForeground)
                    .lineLimit(1)

                Spacer()

                Button(role: .destructive) {
                    onDelete()
                } label: {
                    Image(systemName: "trash")
                        .font(.caption)
                        .foregroundStyle(Color.brandDestructive)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("delete-ban-\(ban.id)")
                .accessibilityLabel(NSLocalizedString("admin_remove_ban", comment: "Remove ban"))
            }

            // Reason
            if let reason = ban.reason, !reason.isEmpty {
                Text(reason)
                    .font(.brand(.subheadline))
                    .foregroundStyle(Color.brandMutedForeground)
                    .lineLimit(2)
            }

            // Metadata
            HStack(spacing: 12) {
                HStack(spacing: 4) {
                    Image(systemName: "person.fill")
                        .font(.caption2)
                    Text(ban.creatorDisplay)
                        .font(.brand(.caption))
                }
                .foregroundStyle(.tertiary)

                if let date = ban.createdDate {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(.brand(.caption))
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}
