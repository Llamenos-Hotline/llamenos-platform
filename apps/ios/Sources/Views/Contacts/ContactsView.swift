import SwiftUI

// MARK: - ContactsView

struct ContactsView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModelBox = ViewModelBox<ContactsViewModel>()
    @State private var showCreateContact = false

    var body: some View {
        let vm = resolvedViewModel

        ZStack {
            if vm.isLoading && vm.contacts.isEmpty {
                loadingState
            } else if let error = vm.errorMessage, vm.contacts.isEmpty {
                errorState(error, vm: vm)
            } else if vm.contacts.isEmpty {
                emptyState
            } else {
                contactsList(vm: vm)
            }
        }
        .navigationTitle(NSLocalizedString("contacts_title", comment: "Contacts"))
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                contactTypeFilterMenu(vm: vm)
            }
            ToolbarItem(placement: .secondaryAction) {
                Button {
                    showCreateContact = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityIdentifier("contacts-add-button")
            }
        }
        .sheet(isPresented: $showCreateContact) {
            CreateContactView { _ in
                Task { await vm.refresh() }
            }
        }
        .searchable(
            text: Binding(
                get: { vm.searchQuery },
                set: { vm.searchQuery = $0 }
            ),
            prompt: NSLocalizedString("contacts_search_prompt", comment: "Search by identifier...")
        )
        .onSubmit(of: .search) {
            Task { await vm.search() }
        }
        .refreshable {
            await vm.refresh()
        }
        .task {
            await vm.loadContacts()
        }
        .navigationDestination(for: ContactNavDestination.self) { destination in
            switch destination {
            case .timeline(let contactHash, let displayIdentifier):
                ContactTimelineView(
                    contactHash: contactHash,
                    displayIdentifier: displayIdentifier
                )
            case .detail(let contactHash, let displayIdentifier):
                ContactDetailView(
                    contactHash: contactHash,
                    displayIdentifier: displayIdentifier
                )
            }
        }
    }

    // MARK: - Contact Type Filter Menu

    @ViewBuilder
    private func contactTypeFilterMenu(vm: ContactsViewModel) -> some View {
        Menu {
            Button {
                Task { await vm.filterByContactType(nil) }
            } label: {
                if vm.selectedContactType == nil {
                    Label(
                        NSLocalizedString("contact_directory_filter_all", comment: "All Types"),
                        systemImage: "checkmark"
                    )
                } else {
                    Text(NSLocalizedString("contact_directory_filter_all", comment: "All Types"))
                }
            }

            Divider()

            ForEach(vm.contactTypes, id: \.self) { contactType in
                Button {
                    Task { await vm.filterByContactType(contactType) }
                } label: {
                    if vm.selectedContactType == contactType {
                        Label(contactType, systemImage: "checkmark")
                    } else {
                        Text(contactType)
                    }
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease.circle")
                .font(.brand(.body))
                .symbolVariant(vm.selectedContactType != nil ? .fill : .none)
        }
        .accessibilityIdentifier("contacts-type-filter-button")
    }

    // MARK: - Contacts List

    @ViewBuilder
    private func contactsList(vm: ContactsViewModel) -> some View {
        List {
            ForEach(vm.contacts) { contact in
                NavigationLink(value: ContactNavDestination.detail(
                    contactHash: contact.contactHash,
                    displayIdentifier: contact.displayIdentifier
                )) {
                    ContactRowView(contact: contact)
                }
                .accessibilityIdentifier("contact-row-\(contact.contactHash)")
                .onAppear {
                    // Load more when nearing the end
                    if contact.id == vm.contacts.last?.id && vm.hasMore {
                        Task { await vm.loadMore() }
                    }
                }
            }

            if vm.hasMore {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("contacts-list")
    }

    // MARK: - Empty State

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("contacts_empty_title", comment: "No Contacts"),
                systemImage: "person.crop.circle.badge.questionmark"
            )
        } description: {
            Text(NSLocalizedString(
                "contacts_empty_message",
                comment: "Contact records will appear here when callers interact with the hotline."
            ))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("contacts-empty-state")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("contacts_loading", comment: "Loading contacts..."))
                .font(.brand(.subheadline))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("contacts-loading")
    }

    // MARK: - Error State

    @ViewBuilder
    private func errorState(_ error: String, vm: ContactsViewModel) -> some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("contacts_error_title", comment: "Unable to Load"),
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
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("contacts-error")
    }

    // MARK: - ViewModel Resolution

    private var resolvedViewModel: ContactsViewModel {
        if let existing = viewModelBox.value { return existing }
        let vm = ContactsViewModel(apiService: appState.apiService)
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - Contact Navigation Destination

enum ContactNavDestination: Hashable {
    case timeline(contactHash: String, displayIdentifier: String)
    case detail(contactHash: String, displayIdentifier: String)
}

// MARK: - ContactRowView

struct ContactRowView: View {
    let contact: ContactSummary

    var body: some View {
        HStack(spacing: 12) {
            GeneratedAvatar(hash: contact.contactHash, size: 36)

            VStack(alignment: .leading, spacing: 8) {
            // Identifier
            Text(contact.displayIdentifier)
                .font(.brandMono(.body))
                .fontWeight(.medium)
                .foregroundStyle(Color.brandForeground)

            // Interaction badges
            HStack(spacing: 10) {
                if contact.callCount > 0 {
                    interactionBadge(icon: "phone.fill", count: contact.callCount, color: Color.brandPrimary)
                }
                if contact.conversationCount > 0 {
                    interactionBadge(icon: "message.fill", count: contact.conversationCount, color: .statusActive)
                }
                if contact.noteCount > 0 {
                    interactionBadge(icon: "doc.text.fill", count: contact.noteCount, color: Color.brandDarkTeal)
                }
                if contact.reportCount > 0 {
                    interactionBadge(icon: "exclamationmark.triangle.fill", count: contact.reportCount, color: Color.brandAccent)
                }

                Spacer()

                // Last seen
                if let date = DateFormatting.parseISO(contact.lastSeen) {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(.brand(.caption))
                        .foregroundStyle(Color.brandMutedForeground)
                }
            }
            } // VStack
        } // HStack
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func interactionBadge(icon: String, count: Int, color: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.brand(.caption))
            Text("\(count)")
                .font(.brand(.caption))
                .fontWeight(.medium)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Capsule().fill(color.opacity(0.12)))
    }

}
