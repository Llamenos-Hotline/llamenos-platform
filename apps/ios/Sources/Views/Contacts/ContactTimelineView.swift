import SwiftUI

// MARK: - ContactTimelineView

struct ContactTimelineView: View {
    @Environment(AppState.self) private var appState
    let contactHash: String
    let displayIdentifier: String
    @State private var viewModelBox = ViewModelBox<ContactTimelineViewModel>()

    var body: some View {
        let vm = resolvedViewModel

        ZStack {
            if vm.isLoading && vm.events.isEmpty {
                loadingState
            } else if let error = vm.errorMessage, vm.events.isEmpty {
                errorState(error, vm: vm)
            } else if vm.events.isEmpty {
                emptyState
            } else {
                timelineList(vm: vm)
            }
        }
        .navigationTitle(displayIdentifier)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await vm.refresh()
        }
        .task {
            await vm.loadTimeline()
        }
        .accessibilityIdentifier("contact-timeline")
    }

    // MARK: - Timeline List

    @ViewBuilder
    private func timelineList(vm: ContactTimelineViewModel) -> some View {
        List {
            // Summary header
            Section {
                HStack(spacing: 16) {
                    GeneratedAvatar(hash: contactHash, size: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(displayIdentifier)
                            .font(.brandMono(.headline))
                            .foregroundStyle(Color.brandForeground)
                        Text(L10n.format("contact_interactions_count", comment: "%d interactions", vm.total))
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                    }
                }
                .padding(.vertical, 4)
            }

            // Events
            Section {
                ForEach(vm.events) { event in
                    TimelineEventRow(event: event)
                        .accessibilityIdentifier("timeline-event-\(event.id)")
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Empty State

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("timeline_empty_title", comment: "No Interactions"),
                systemImage: "clock.badge.questionmark"
            )
        } description: {
            Text(NSLocalizedString(
                "timeline_empty_message",
                comment: "No interactions have been recorded for this contact."
            ))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("timeline-empty-state")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("timeline_loading", comment: "Loading timeline..."))
                .font(.brand(.subheadline))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("timeline-loading")
    }

    // MARK: - Error State

    @ViewBuilder
    private func errorState(_ error: String, vm: ContactTimelineViewModel) -> some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("timeline_error_title", comment: "Unable to Load"),
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
        .accessibilityIdentifier("timeline-error")
    }

    // MARK: - ViewModel Resolution

    private var resolvedViewModel: ContactTimelineViewModel {
        if let existing = viewModelBox.value { return existing }
        let vm = ContactTimelineViewModel(apiService: appState.apiService, contactHash: contactHash)
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - TimelineEventRow

struct TimelineEventRow: View {
    let event: ContactTimelineEvent

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Type icon
            Image(systemName: event.eventType.icon)
                .font(.brand(.body))
                .foregroundStyle(event.eventType.color)
                .frame(width: 28, height: 28)
                .background(
                    Circle()
                        .fill(event.eventType.color.opacity(0.12))
                        .frame(width: 28, height: 28)
                )

            VStack(alignment: .leading, spacing: 4) {
                // Type + status
                HStack(spacing: 6) {
                    Text(event.eventType.displayName)
                        .font(.brand(.subheadline))
                        .fontWeight(.medium)

                    if let status = event.status {
                        Text(status)
                            .font(.brand(.caption2))
                            .fontWeight(.medium)
                            .foregroundStyle(event.eventType.color)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(
                                Capsule().fill(event.eventType.color.opacity(0.12))
                            )
                    }
                }

                // Summary
                if let summary = event.summary, !summary.isEmpty {
                    Text(summary)
                        .font(.brand(.caption))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                // Timestamp + duration
                HStack(spacing: 8) {
                    if let date = DateFormatting.parseISO(event.timestamp) {
                        Text(date.formatted(date: .abbreviated, time: .shortened))
                            .font(.brand(.caption2))
                            .foregroundStyle(.tertiary)
                    }

                    if let duration = event.duration, duration > 0 {
                        Text(formatDuration(duration))
                            .font(.brand(.caption2))
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }


    private func formatDuration(_ seconds: Int) -> String {
        let mins = seconds / 60
        let secs = seconds % 60
        if mins > 0 {
            return L10n.format("duration_min_sec", comment: "%dm %ds", mins, secs)
        }
        return L10n.format("duration_sec", comment: "%ds", secs)
    }
}
