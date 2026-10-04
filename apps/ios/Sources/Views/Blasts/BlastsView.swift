import SwiftUI

// MARK: - BlastsView

struct BlastsView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModelBox = ViewModelBox<BlastsViewModel>()

    var body: some View {
        let vm = resolvedViewModel

        ZStack {
            if vm.isLoading && vm.blasts.isEmpty {
                loadingState
            } else if let error = vm.errorMessage, vm.blasts.isEmpty {
                errorState(error, vm: vm)
            } else if vm.blasts.isEmpty {
                emptyState(vm: vm)
            } else {
                blastsList(vm: vm)
            }
        }
        .navigationTitle(NSLocalizedString("blasts_title", comment: "Message Blasts"))
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    vm.showCreateSheet = true
                } label: {
                    Image(systemName: "plus.circle.fill")
                        .font(.brand(.body))
                }
                .accessibilityIdentifier("create-blast-button")
            }
        }
        .sheet(isPresented: Binding(
            get: { vm.showCreateSheet },
            set: { vm.showCreateSheet = $0 }
        )) {
            CreateBlastView(viewModel: vm)
        }
        .refreshable {
            await vm.refresh()
        }
        .task {
            await vm.refresh()
        }
    }

    // MARK: - Blasts List

    @ViewBuilder
    private func blastsList(vm: BlastsViewModel) -> some View {
        List {
            // Subscriber stats section
            if let stats = vm.subscriberStats {
                Section {
                    HStack(spacing: 16) {
                        statBadge(
                            label: NSLocalizedString("blast_stat_active", comment: "Active"),
                            count: stats.active,
                            color: .statusActive
                        )
                        statBadge(
                            label: NSLocalizedString("blast_stat_total", comment: "Total"),
                            count: stats.total,
                            color: Color.brandPrimary
                        )
                        statBadge(
                            label: NSLocalizedString("blast_stat_paused", comment: "Paused"),
                            count: stats.paused,
                            color: Color.brandAccent
                        )
                    }
                    .frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("blast-subscriber-stats")
            }

            // Blasts
            Section {
                ForEach(vm.blasts) { blast in
                    BlastRowView(blast: blast, onSend: {
                        Task { await vm.sendBlast(id: blast.id) }
                    })
                    .accessibilityIdentifier("blast-row-\(blast.id)")
                }
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("blasts-list")
    }

    // MARK: - Empty State

    @ViewBuilder
    private func emptyState(vm: BlastsViewModel) -> some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("blasts_empty_title", comment: "No Message Blasts"),
                systemImage: "megaphone"
            )
        } description: {
            Text(NSLocalizedString(
                "blasts_empty_message",
                comment: "Create a message blast to reach all subscribers at once."
            ))
        } actions: {
            Button {
                vm.showCreateSheet = true
            } label: {
                Text(NSLocalizedString("blasts_create_first", comment: "Create First Blast"))
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("create-first-blast")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("blasts-empty-state")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("blasts_loading", comment: "Loading blasts..."))
                .font(.brand(.subheadline))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("blasts-loading")
    }

    // MARK: - Error State

    @ViewBuilder
    private func errorState(_ error: String, vm: BlastsViewModel) -> some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("blasts_error_title", comment: "Unable to Load"),
                systemImage: "exclamationmark.triangle"
            )
        } description: {
            Text(error)
        } actions: {
            Button {
                Task { await vm.refresh() }
            } label: {
                Text(NSLocalizedString("retry", comment: "Retry"))
            }
            .buttonStyle(.bordered)
        }
        .accessibilityIdentifier("blasts-error")
    }

    // MARK: - Stat Badge

    @ViewBuilder
    private func statBadge(label: String, count: Int, color: Color) -> some View {
        VStack(spacing: 4) {
            Text("\(count)")
                .font(.brand(.title3))
                .fontWeight(.bold)
                .foregroundStyle(color)
            Text(label)
                .font(.brand(.caption))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - ViewModel Resolution

    private var resolvedViewModel: BlastsViewModel {
        if let existing = viewModelBox.value { return existing }
        let vm = BlastsViewModel(apiService: appState.apiService)
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - BlastRowView

struct BlastRowView: View {
    let blast: AppBlast
    let onSend: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Name + status
            HStack {
                Text(blast.name)
                    .font(.brand(.body))
                    .fontWeight(.medium)

                Spacer()

                statusBadge(blast.statusEnum)
            }

            // Message preview
            Text(blast.messagePreview)
                .font(.brand(.caption))
                .foregroundStyle(.secondary)
                .lineLimit(2)

            // Channels + date
            HStack(spacing: 8) {
                ForEach(blast.targetChannels, id: \.self) { channel in
                    Text(channel)
                        .font(.brand(.caption))
                        .fontWeight(.medium)
                        .foregroundStyle(Color.brandAccent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.brandAccent.opacity(0.12)))
                }

                Spacer()

                if let date = DateFormatting.parseISO(blast.createdAt) {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(.brand(.footnote))
                        .foregroundStyle(.tertiary)
                }
            }

            // Send button for drafts
            if blast.statusEnum == .draft {
                Button {
                    onSend()
                } label: {
                    Label(
                        NSLocalizedString("blast_send", comment: "Send Now"),
                        systemImage: "paperplane.fill"
                    )
                    .font(.brand(.caption))
                }
                .buttonStyle(.bordered)
                .tint(.brandPrimary)
                .accessibilityIdentifier("send-blast-\(blast.id)")
            }
        }
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func statusBadge(_ status: SharedBlastListResponseStatus) -> some View {
        HStack(spacing: 4) {
            Image(systemName: status.icon)
                .font(.brand(.caption))
            Text(status.displayName)
                .font(.brand(.caption))
                .fontWeight(.medium)
        }
        .foregroundStyle(status.color)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(status.color.opacity(0.12)))
    }

}
