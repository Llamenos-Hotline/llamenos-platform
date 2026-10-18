import SwiftUI

struct EditContactView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppState.self) private var appState
    @Environment(HubKeyStore.self) private var hubKeyStore
    @State private var vm: ContactFormViewModel?

    let contact: DirectoryContact
    var onUpdated: (Contact) -> Void

    var body: some View {
        NavigationStack {
            if let vm {
                ContactFormFields(vm: vm)
                    .navigationTitle(NSLocalizedString("contacts_edit_title", comment: "Edit Contact"))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(NSLocalizedString("common_cancel", comment: "Cancel")) { dismiss() }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            Button(NSLocalizedString("common_save", comment: "Save")) { update() }
                                .disabled(vm.displayName.trimmingCharacters(in: .whitespaces).isEmpty || vm.isSaving)
                        }
                    }
            }
        }
        .onAppear {
            if vm == nil {
                let newVM = ContactFormViewModel(cryptoService: appState.cryptoService)
                newVM.populate(from: contact)
                vm = newVM
            }
        }
    }

    private func update() {
        guard let vm else { return }
        guard let hubKey = hubKeyStore.currentHubKey else {
            vm.error = NSLocalizedString("error_no_hub_key", comment: "Hub key not available")
            return
        }
        guard let hubId = appState.hubContext.activeHubId else {
            vm.error = NSLocalizedString("error_no_hub_selected", comment: "No hub selected")
            return
        }

        var readerPubkeys: [String] = []
        if let pubkey = appState.cryptoService.encryptionPubkeyHex {
            readerPubkeys.append(pubkey)
        }
        if let adminPubkey = appState.adminDecryptionPubkey,
           !readerPubkeys.contains(adminPubkey) {
            readerPubkeys.append(adminPubkey)
        }

        let contactsAPI = ContactsAPIService(apiService: appState.apiService)

        Task {
            do {
                let updated = try await vm.update(
                    contactId: contact.id,
                    hubId: hubId,
                    hubKey: hubKey,
                    readerPubkeys: readerPubkeys,
                    apiService: contactsAPI
                )
                await MainActor.run { onUpdated(updated); dismiss() }
            } catch {
                vm.error = error.localizedDescription
            }
        }
    }
}

// Shared form fields sub-view
struct ContactFormFields: View {
    @Environment(AppState.self) private var appState
    @Bindable var vm: ContactFormViewModel
    @State private var tagsBox = ViewModelBox<TagsViewModel>()

    var body: some View {
        Form {
            Section(NSLocalizedString("contacts_section_basic", comment: "Basic Info")) {
                TextField(NSLocalizedString("contacts_display_name", comment: "Display Name"), text: $vm.displayName)
                    .accessibilityIdentifier("contact-display-name")
                TextField(NSLocalizedString("contacts_phone", comment: "Phone"), text: $vm.phone)
                    .keyboardType(.phonePad)
                TextField(NSLocalizedString("contacts_email", comment: "Email"), text: $vm.email)
                    .keyboardType(.emailAddress)
                    .autocapitalization(.none)
            }
            Section(NSLocalizedString("contacts_section_notes", comment: "Notes")) {
                TextEditor(text: $vm.notes)
                    .frame(minHeight: 80)
            }
            if appState.hasPermission("tags:view") {
                Section(NSLocalizedString("tags_title", comment: "Tags")) {
                    tagPickerSection
                }
            }
            if let error = vm.error {
                Section {
                    Text(error).foregroundStyle(.red).font(.caption)
                }
            }
        }
    }

    /// vm.tags stores slugs (matching the desktop encrypted-summary wire
    /// format); the picker operates on tag IDs. This binding maps between
    /// them via the loaded tag list.
    @ViewBuilder
    private var tagPickerSection: some View {
        let tagsVM = resolvedTagsViewModel
        TagPicker(
            viewModel: tagsVM,
            selectedTagIds: Binding(
                get: {
                    Set(vm.tags.compactMap { slug in
                        tagsVM.tags.first(where: { $0.name == slug })?.id
                    })
                },
                set: { newIds in
                    // Slugs the loaded list cannot resolve (list not loaded yet,
                    // a failed load) are not the picker's to drop.
                    let known = Set(tagsVM.tags.map(\.name))
                    vm.tags = vm.tags.filter { !known.contains($0) }
                        + tagsVM.tags.filter { newIds.contains($0.id) }.map(\.name)
                }
            ),
            canCreate: appState.hasPermission("tags:create")
        )
        .accessibilityIdentifier("contact-tag-picker")
        .task {
            if tagsVM.tags.isEmpty {
                await tagsVM.loadTags()
            }
        }
    }

    private var resolvedTagsViewModel: TagsViewModel {
        if let existing = tagsBox.value { return existing }
        let tagsVM = TagsViewModel(
            tagsAPI: TagsAPIService(apiService: appState.apiService),
            crypto: appState.cryptoService,
            hubIdProvider: { [hubContext = appState.hubContext] in hubContext.activeHubId }
        )
        tagsBox.value = tagsVM
        return tagsVM
    }
}
