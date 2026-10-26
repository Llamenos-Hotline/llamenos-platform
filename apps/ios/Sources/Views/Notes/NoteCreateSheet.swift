import SwiftUI

// MARK: - NoteCreateSheet

/// The note editor, wired to the app: loads the custom fields and the calls a note can be
/// filed against, encrypts and posts the note to the hub its call belongs to, and closes.
///
/// Presented from the Notes tab (no call chosen), from the dashboard's call card and "Call
/// Ended" prompt, and from a call-history detail (the call prefilled). Owns its own
/// `NotesViewModel`; whoever presents it reacts to `onSaved`.
struct NoteCreateSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(HubContext.self) private var hubContext
    @Environment(\.dismiss) private var dismiss

    /// The call to prefill, or nil to let the volunteer choose.
    let initialCall: CallReference?
    /// Calls the app already holds that the picker should offer first.
    var heldCalls: [CallReference] = []
    let onSaved: (CallReference) -> Void

    @State private var notesBox = ViewModelBox<NotesViewModel>()
    @State private var choicesBox = ViewModelBox<NoteCallChoicesViewModel>()

    var body: some View {
        let notes = resolvedNotes
        let choices = resolvedChoices

        NoteCreateView(
            customFields: notes.customFields,
            choices: choices.choices,
            initialCall: initialCall,
            isLoadingChoices: choices.isLoading,
            choicesError: choices.errorMessage,
            onSave: { text, fields, call, transcript in
                await appState.ensureAdminPubkeyLoaded()
                try await notes.createNote(
                    text: text,
                    fields: fields,
                    call: call,
                    transcript: transcript,
                    adminPubkeys: [appState.adminDecryptionPubkey].compactMap { $0 }
                )
                onSaved(call)
                dismiss()
            }
        )
        .task { await notes.loadCustomFields() }
        .task { await choices.load() }
    }

    // MARK: - ViewModel Resolution

    private var resolvedNotes: NotesViewModel {
        if let vm = notesBox.value { return vm }
        let vm = NotesViewModel(apiService: appState.apiService, cryptoService: appState.cryptoService)
        notesBox.value = vm
        return vm
    }

    private var resolvedChoices: NoteCallChoicesViewModel {
        if let vm = choicesBox.value { return vm }
        let vm = NoteCallChoicesViewModel(
            apiService: appState.apiService,
            hubId: initialCall?.hubId ?? hubContext.activeHubId,
            myPubkey: appState.cryptoService.signingPubkeyHex,
            canReadActive: appState.hasPermission("calls:read-active"),
            canReadHistory: appState.hasPermission("calls:read-history"),
            known: ([initialCall].compactMap { $0 } + heldCalls).uniqued()
        )
        choicesBox.value = vm
        return vm
    }
}

private extension Array where Element == CallReference {
    /// The first of each call id, in order.
    func uniqued() -> [CallReference] {
        var seen = Set<String>()
        return filter { seen.insert($0.id).inserted }
    }
}
