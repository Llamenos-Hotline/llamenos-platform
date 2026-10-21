import SwiftUI

struct CreateContactView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppState.self) private var appState
    @Environment(HubKeyStore.self) private var hubKeyStore
    @State private var vm: ContactFormViewModel?

    var onCreated: (Contact) -> Void

    var body: some View {
        NavigationStack {
            if let vm {
                ContactFormFields(vm: vm)
                    .navigationTitle(NSLocalizedString("contacts_create_title", comment: "New Contact"))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(NSLocalizedString("common_cancel", comment: "Cancel")) { dismiss() }
                        }
                        ToolbarItem(placement: .confirmationAction) {
                            Button(NSLocalizedString("common_save", comment: "Save")) { save() }
                                .disabled(vm.displayName.trimmingCharacters(in: .whitespaces).isEmpty || vm.isSaving)
                                .accessibilityIdentifier("contact-save-button")
                        }
                    }
                    .overlay { if vm.isSaving { ProgressView() } }
            }
        }
        .onAppear {
            if vm == nil {
                vm = ContactFormViewModel(cryptoService: appState.cryptoService)
            }
        }
    }

    private func save() {
        guard let vm else { return }
        guard let hubKey = hubKeyStore.currentHubKey else {
            vm.error = NSLocalizedString("error_no_hub_key", comment: "Hub key not available")
            return
        }
        guard let hubId = appState.hubContext.activeHubId else {
            vm.error = NSLocalizedString("error_no_hub_selected", comment: "No hub selected")
            return
        }

        // Build reader pubkeys: current user + admin decryption key
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
                let contact = try await vm.save(
                    hubId: hubId,
                    hubKey: hubKey,
                    readerPubkeys: readerPubkeys,
                    apiService: contactsAPI
                )
                await MainActor.run { onCreated(contact); dismiss() }
            } catch {
                vm.error = error.localizedDescription
            }
        }
    }
}
