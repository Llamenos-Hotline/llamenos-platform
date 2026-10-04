import SwiftUI

/// Admin view for managing cross-hub platform-scoped bans.
/// Platform bans apply across ALL hubs. Hub admins with appropriate
/// permissions can promote hub-scoped bans to platform scope.
struct PlatformBansView: View {
    @Bindable var viewModel: AdminViewModel

    var body: some View {
        ZStack {
            if viewModel.isLoadingPlatformBans && viewModel.platformBans.isEmpty {
                loadingState
            } else if viewModel.platformBans.isEmpty {
                emptyState
            } else {
                banList
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    viewModel.showAddPlatformBanSheet = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.body)
                        .foregroundStyle(Color.brandPrimary)
                }
                .accessibilityIdentifier("add-platform-ban-button")
            }
        }
        .searchable(
            text: $viewModel.platformBanSearchQuery,
            prompt: NSLocalizedString("platform_bans_search_placeholder", comment: "Search bans...")
        )
        .onSubmit(of: .search) {
            Task { await viewModel.searchPlatformBans() }
        }
        .sheet(isPresented: $viewModel.showAddPlatformBanSheet) {
            addPlatformBanSheet
        }
        .refreshable {
            viewModel.isLoadingPlatformBans = false
            await viewModel.loadPlatformBans()
        }
        .task {
            await viewModel.loadPlatformBans()
        }
        .navigationTitle(NSLocalizedString("platform_bans_title", comment: "Platform Bans"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("platform-bans-view")
    }

    // MARK: - Ban List

    private var banList: some View {
        List {
            if !viewModel.platformBanSearchResults.isEmpty {
                Section(header: Text(NSLocalizedString("platform_bans_search_title", comment: "Search Results"))) {
                    ForEach(viewModel.platformBanSearchResults) { (ban: SearchBansResponseBan) in
                        BanRowView(ban: ban) {}
                            .overlay(alignment: .topTrailing) {
                                BadgeView(
                                    text: ban.hubID == nil
                                        ? NSLocalizedString("platform_bans_scope_platform", comment: "Platform")
                                        : NSLocalizedString("platform_bans_scope_hub", comment: "Hub"),
                                    icon: ban.hubID == nil ? "globe" : "building.2",
                                    color: ban.hubID == nil ? .purple : .blue,
                                    style: .subtle
                                )
                            }
                    }
                }
            }

            Section(header: Text(NSLocalizedString("platform_bans_title", comment: "Platform Bans"))) {
                ForEach(viewModel.platformBans) { ban in
                    BanRowView(ban: ban) {
                        viewModel.confirmDelete(id: ban.id, type: .ban)
                    }
                    .accessibilityIdentifier("platform-ban-row-\(ban.id)")
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Add Platform Ban Sheet

    private var addPlatformBanSheet: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(NSLocalizedString("admin_ban_hash_label", comment: "Identifier Hash"))
                            .font(.brand(.caption))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)

                        TextField(
                            NSLocalizedString("admin_ban_hash_placeholder", comment: "SHA-256 hash"),
                            text: $viewModel.newBanIdentifierHash
                        )
                        .font(.brandMono(.body))
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
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
                    }
                } header: {
                    Text(NSLocalizedString("platform_bans_create_button", comment: "Create Platform Ban"))
                } footer: {
                    Text(NSLocalizedString(
                        "platform_bans_description",
                        comment: "Bans that apply across all hubs"
                    ))
                    .font(.brand(.caption))
                }
            }
            .navigationTitle(NSLocalizedString("platform_bans_create_button", comment: "Create Platform Ban"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        viewModel.newBanIdentifierHash = ""
                        viewModel.newBanReason = ""
                        viewModel.showAddPlatformBanSheet = false
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("admin_ban_submit", comment: "Add Ban")) {
                        Task { await viewModel.addPlatformBan() }
                    }
                    .fontWeight(.semibold)
                    .disabled(viewModel.newBanIdentifierHash.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    // MARK: - Empty / Loading

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("platform_bans_empty_state", comment: "No platform-scoped bans"),
                systemImage: "hand.raised"
            )
        } description: {
            Text(NSLocalizedString(
                "platform_bans_empty_state_description",
                comment: "Platform bans block callers across all hubs."
            ))
        } actions: {
            Button {
                viewModel.showAddPlatformBanSheet = true
            } label: {
                Text(NSLocalizedString("platform_bans_create_button", comment: "Create Platform Ban"))
            }
            .buttonStyle(.bordered)
        }
    }

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("admin_loading_bans", comment: "Loading ban list..."))
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
