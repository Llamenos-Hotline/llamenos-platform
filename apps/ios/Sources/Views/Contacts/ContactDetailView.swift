import SwiftUI

// MARK: - ContactDetailView

/// Contact profile detail showing linked cases, relationships, identifiers,
/// and the interaction timeline.
struct ContactDetailView: View {
    @Environment(AppState.self) private var appState
    let contactHash: String
    let displayIdentifier: String
    @State private var viewModelBox = ViewModelBox<ContactDetailViewModel>()

    var body: some View {
        let vm = resolvedViewModel

        ZStack {
            if vm.isLoading && vm.contact == nil {
                loadingState
            } else if let error = vm.errorMessage, vm.contact == nil {
                errorState(error, vm: vm)
            } else if let contact = vm.contact {
                contactProfile(contact: contact, vm: vm)
            } else {
                loadingState
            }
        }
        .navigationTitle(displayIdentifier)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await vm.refresh()
        }
        .task {
            await vm.loadAll()
        }
        .navigationDestination(for: String.self) { contactHash in
            ContactTimelineView(
                contactHash: contactHash,
                displayIdentifier: vm.contact?.displayIdentifier ?? contactHash
            )
        }
        .accessibilityIdentifier("contact-detail")
    }

    // MARK: - Contact Profile

    @ViewBuilder
    private func contactProfile(contact: ContactDetail, vm: ContactDetailViewModel) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Header with avatar and summary
                headerSection(contact: contact)

                // Identifiers section
                if let identifiers = contact.identifiers, !identifiers.isEmpty {
                    identifiersSection(identifiers: identifiers)
                }

                // Interaction summary
                interactionSummary(contact: contact)

                // Linked cases
                if let linkedCases = contact.linkedCases, !linkedCases.isEmpty {
                    linkedCasesSection(cases: linkedCases)
                }

                // Relationships
                if !vm.relationships.isEmpty {
                    relationshipsSection(relationships: vm.relationships)
                }

                // Timeline link
                NavigationLink(value: contactHash) {
                    HStack {
                        Image(systemName: "clock.fill")
                            .foregroundStyle(Color.brandPrimary)
                        Text(NSLocalizedString("contact_directory_view_timeline", comment: "View Full Timeline"))
                            .font(.brand(.body))
                            .fontWeight(.medium)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .foregroundStyle(.tertiary)
                    }
                    .padding(16)
                    .background(
                        RoundedRectangle(cornerRadius: 12)
                            .fill(Color.brandCard)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 12)
                            .stroke(Color.brandBorder, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("contact-timeline-link")
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
    }

    // MARK: - Header Section

    @ViewBuilder
    private func headerSection(contact: ContactDetail) -> some View {
        BrandCard {
            HStack(spacing: 16) {
                GeneratedAvatar(hash: contactHash, size: 56)

                VStack(alignment: .leading, spacing: 4) {
                    Text(contact.displayIdentifier)
                        .font(.brandMono(.title3))
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.brandForeground)

                    if let contactType = contact.contactType {
                        Text(contactType)
                            .font(.brand(.caption))
                            .fontWeight(.medium)
                            .foregroundStyle(Color.brandPrimary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(
                                Capsule().fill(Color.brandPrimary.opacity(0.12))
                            )
                    }

                    HStack(spacing: 12) {
                        if let firstDate = DateFormatting.parseISO(contact.firstSeen) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(NSLocalizedString("contact_directory_first_seen", comment: "First seen"))
                                    .font(.brand(.caption2))
                                    .foregroundStyle(.tertiary)
                                Text(firstDate.formatted(date: .abbreviated, time: .omitted))
                                    .font(.brand(.caption))
                                    .foregroundStyle(.secondary)
                            }
                        }

                        if let lastDate = DateFormatting.parseISO(contact.lastSeen) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(NSLocalizedString("contact_directory_last_seen", comment: "Last seen"))
                                    .font(.brand(.caption2))
                                    .foregroundStyle(.tertiary)
                                Text(lastDate.formatted(date: .abbreviated, time: .omitted))
                                    .font(.brand(.caption))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .padding(16)
        }
        .accessibilityIdentifier("contact-header")
    }

    // MARK: - Identifiers Section

    @ViewBuilder
    private func identifiersSection(identifiers: [ContactIdentifier]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(NSLocalizedString("contact_directory_identifiers", comment: "Identifiers"))
                .font(.brand(.headline))
                .foregroundStyle(Color.brandForeground)

            BrandCard {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(identifiers) { identifier in
                        HStack(spacing: 10) {
                            Image(systemName: identifierIcon(for: identifier.type))
                                .foregroundStyle(Color.brandPrimary)
                                .frame(width: 20)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(identifier.type.capitalized)
                                    .font(.brand(.caption))
                                    .foregroundStyle(.tertiary)
                                Text(identifier.value ?? identifier.hash.prefix(12) + "...")
                                    .font(.brandMono(.body))
                                    .foregroundStyle(Color.brandForeground)
                            }
                        }
                    }
                }
                .padding(16)
            }
        }
        .accessibilityIdentifier("contact-identifiers")
    }

    // MARK: - Interaction Summary

    @ViewBuilder
    private func interactionSummary(contact: ContactDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(NSLocalizedString("contact_directory_interactions", comment: "Interactions"))
                .font(.brand(.headline))
                .foregroundStyle(Color.brandForeground)

            HStack(spacing: 12) {
                interactionStatCard(
                    icon: "phone.fill",
                    count: contact.callCount,
                    label: NSLocalizedString("contact_directory_calls", comment: "Calls"),
                    color: Color.brandPrimary
                )
                interactionStatCard(
                    icon: "message.fill",
                    count: contact.conversationCount,
                    label: NSLocalizedString("contact_directory_messages", comment: "Messages"),
                    color: .statusActive
                )
                interactionStatCard(
                    icon: "doc.text.fill",
                    count: contact.noteCount,
                    label: NSLocalizedString("contact_directory_notes", comment: "Notes"),
                    color: Color.brandDarkTeal
                )
                interactionStatCard(
                    icon: "exclamationmark.triangle.fill",
                    count: contact.reportCount,
                    label: NSLocalizedString("contact_directory_reports", comment: "Reports"),
                    color: Color.brandAccent
                )
            }
        }
        .accessibilityIdentifier("contact-interactions")
    }

    @ViewBuilder
    private func interactionStatCard(icon: String, count: Int, label: String, color: Color) -> some View {
        BrandCard {
            VStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.brand(.body))
                    .foregroundStyle(color)
                Text("\(count)")
                    .font(.brand(.title3))
                    .fontWeight(.bold)
                    .foregroundStyle(Color.brandForeground)
                Text(label)
                    .font(.brand(.caption2))
                    .foregroundStyle(Color.brandMutedForeground)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(10)
        }
    }

    // MARK: - Linked Cases Section

    @ViewBuilder
    private func linkedCasesSection(cases: [ContactLinkedCase]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(NSLocalizedString("contact_directory_linked_cases", comment: "Linked Cases"))
                .font(.brand(.headline))
                .foregroundStyle(Color.brandForeground)

            ForEach(cases) { linkedCase in
                BrandCard {
                    HStack(spacing: 12) {
                        Image(systemName: "folder.fill")
                            .foregroundStyle(Color.brandPrimary)

                        VStack(alignment: .leading, spacing: 4) {
                            Text(linkedCase.caseNumber ?? linkedCase.id.prefix(8) + "...")
                                .font(.brandMono(.body))
                                .fontWeight(.medium)
                                .foregroundStyle(Color.brandForeground)

                            HStack(spacing: 8) {
                                if let role = linkedCase.role {
                                    Text(role)
                                        .font(.brand(.caption))
                                        .foregroundStyle(Color.brandPrimary)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 1)
                                        .background(
                                            Capsule().fill(Color.brandPrimary.opacity(0.12))
                                        )
                                }

                                Text(linkedCase.statusHash)
                                    .font(.brand(.caption))
                                    .foregroundStyle(.secondary)
                            }
                        }

                        Spacer()

                        if let date = DateFormatting.parseISO(linkedCase.createdAt) {
                            Text(date.formatted(date: .abbreviated, time: .omitted))
                                .font(.brand(.caption2))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .padding(12)
                }
                .accessibilityIdentifier("linked-case-\(linkedCase.id)")
            }
        }
        .accessibilityIdentifier("contact-linked-cases")
    }

    // MARK: - Relationships Section

    @ViewBuilder
    private func relationshipsSection(relationships: [AppContactRelationship]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(NSLocalizedString("contact_directory_relationships", comment: "Relationships"))
                .font(.brand(.headline))
                .foregroundStyle(Color.brandForeground)

            ForEach(relationships) { relationship in
                BrandCard {
                    HStack(spacing: 12) {
                        GeneratedAvatar(hash: relationship.relatedContactHash, size: 32)

                        VStack(alignment: .leading, spacing: 2) {
                            Text(relationship.relatedDisplayIdentifier)
                                .font(.brandMono(.body))
                                .foregroundStyle(Color.brandForeground)

                            Text(relationship.relationshipType)
                                .font(.brand(.caption))
                                .foregroundStyle(.secondary)
                        }

                        Spacer()

                        Image(systemName: "chevron.right")
                            .foregroundStyle(.tertiary)
                    }
                    .padding(12)
                }
                .accessibilityIdentifier("relationship-\(relationship.relatedContactHash)")
            }
        }
        .accessibilityIdentifier("contact-relationships")
    }

    // MARK: - Helpers

    private func identifierIcon(for type: String) -> String {
        switch type.lowercased() {
        case "phone": return "phone.fill"
        case "email": return "envelope.fill"
        case "name": return "person.fill"
        default: return "tag.fill"
        }
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("contact_directory_loading", comment: "Loading contact..."))
                .font(.brand(.subheadline))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("contact-detail-loading")
    }

    // MARK: - Error State

    @ViewBuilder
    private func errorState(_ error: String, vm: ContactDetailViewModel) -> some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("contact_directory_error", comment: "Unable to Load"),
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
        .accessibilityIdentifier("contact-detail-error")
    }

    // MARK: - ViewModel Resolution

    private var resolvedViewModel: ContactDetailViewModel {
        if let existing = viewModelBox.value { return existing }
        let vm = ContactDetailViewModel(apiService: appState.apiService, contactHash: contactHash)
        viewModelBox.value = vm
        return vm
    }
}
