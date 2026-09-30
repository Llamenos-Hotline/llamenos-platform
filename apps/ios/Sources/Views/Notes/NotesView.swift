import SwiftUI

// MARK: - NotesView

/// Main notes list view showing all decrypted notes with pull-to-refresh,
/// pagination, and a floating action button for creating new notes.
struct NotesView: View {
    @Environment(AppState.self) private var appState
    @Environment(Router.self) private var router
    @Environment(HubContext.self) private var hubContext
    @State private var viewModelBox = ViewModelBox<NotesViewModel>()

    var body: some View {
        let vm = resolvedViewModel

        NavigationStack {
            ZStack {
                if vm.isLoading && vm.notes.isEmpty {
                    loadingState
                } else if let error = vm.errorMessage, vm.notes.isEmpty {
                    errorState(error, vm: vm)
                } else if vm.notes.isEmpty {
                    emptyState
                } else {
                    notesList(vm: vm)
                }
            }
            .navigationTitle(NSLocalizedString("notes_title", comment: "Notes"))
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        vm.showCreateSheet = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                            .font(.body.weight(.semibold))
                    }
                    .accessibilityIdentifier("create-note-button")
                    .accessibilityLabel(NSLocalizedString("notes_create", comment: "Create Note"))
                }
            }
            .sheet(isPresented: Binding(
                get: { vm.showCreateSheet },
                set: { vm.showCreateSheet = $0 }
            )) {
                NoteCreateView(
                    customFields: vm.customFields,
                    onSave: { text, fields, callId, transcript in
                        await appState.ensureAdminPubkeyLoaded()
                        try await vm.createNote(
                            text: text,
                            fields: fields,
                            callId: callId,
                            transcript: transcript,
                            adminPubkeys: [appState.adminDecryptionPubkey].compactMap { $0 }
                        )
                        vm.showCreateSheet = false
                    }
                )
            }
            .refreshable {
                await vm.refresh()
            }
            .task(id: hubContext.activeHubId) {
                await vm.loadNotes()
            }
            .navigationDestination(for: String.self) { noteId in
                if let note = vm.notes.first(where: { $0.id == noteId }) {
                    NoteDetailView(note: note, customFields: vm.customFields)
                }
            }
        }
    }

    // MARK: - Notes List

    @ViewBuilder
    private func notesList(vm: NotesViewModel) -> some View {
        List {
            ForEach(vm.notes) { note in
                NavigationLink(value: note.id) {
                    NoteRowView(note: note)
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                .accessibilityIdentifier("note-row-\(note.id)")
            }

            if vm.hasMore {
                HStack {
                    Spacer()
                    if vm.isLoadingMore {
                        ProgressView()
                            .padding()
                    } else {
                        Button {
                            Task { await vm.loadMoreNotes() }
                        } label: {
                            Text(NSLocalizedString("notes_load_more", comment: "Load More"))
                                .font(.brand(.subheadline))
                                .foregroundStyle(Color.brandPrimary)
                        }
                        .padding()
                    }
                    Spacer()
                }
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("notes-list")
    }

    // MARK: - Empty State

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("notes_empty_title", comment: "No Notes Yet"),
                systemImage: "note.text"
            )
        } description: {
            Text(NSLocalizedString(
                "notes_empty_message",
                comment: "Notes you create during calls will appear here."
            ))
        } actions: {
            Button {
                resolvedViewModel.showCreateSheet = true
            } label: {
                Text(NSLocalizedString("notes_create_first", comment: "Create Your First Note"))
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("create-first-note")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("notes-empty-state")
    }

    // MARK: - Loading State

    private var loadingState: some View {
        VStack(spacing: 16) {
            ProgressView()
                .scaleEffect(1.2)
            Text(NSLocalizedString("notes_loading", comment: "Loading notes..."))
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("notes-loading")
    }

    // MARK: - Error State

    @ViewBuilder
    private func errorState(_ error: String, vm: NotesViewModel) -> some View {
        ContentUnavailableView {
            Label(
                NSLocalizedString("notes_error_title", comment: "Unable to Load"),
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
        .accessibilityIdentifier("notes-error")
    }

    // MARK: - ViewModel Resolution

    private var resolvedViewModel: NotesViewModel {
        if let vm = viewModelBox.value {
            return vm
        }
        let vm = NotesViewModel(apiService: appState.apiService, cryptoService: appState.cryptoService)
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - NoteRowView

/// A single note row in the list, showing preview text, metadata badges, and date.
/// Wrapped in a BrandCard with a colored left accent border indicating note type.
struct NoteRowView: View {
    let note: DecryptedNote

    /// Accent color based on linked entity: teal for calls, green for conversations, default border for standalone.
    private var accentColor: Color {
        if note.callId != nil { return .teal }
        if note.conversationId != nil { return .green }
        return .brandBorder
    }

    var body: some View {
        HStack(spacing: 0) {
            // Left accent border
            RoundedRectangle(cornerRadius: 2)
                .fill(accentColor)
                .frame(width: 4)

            // Content
            VStack(alignment: .leading, spacing: 8) {
                // Note preview text
                Text(note.preview)
                    .font(.brand(.body))
                    .lineLimit(3)
                    .foregroundStyle(Color.brandForeground)

                // Metadata row
                HStack(spacing: 8) {
                    // Author
                    HStack(spacing: 4) {
                        Image(systemName: "person.fill")
                            .font(.brand(.caption2))
                        Text(note.authorDisplayName)
                            .font(.brand(.caption))
                    }
                    .foregroundStyle(Color.brandMutedForeground)

                    // Call/Conversation badge
                    if note.callId != nil {
                        BadgeView(
                            text: NSLocalizedString("notes_call_badge", comment: "Call"),
                            icon: "phone.fill",
                            color: .teal,
                            style: .subtle
                        )
                    }
                    if note.conversationId != nil {
                        BadgeView(
                            text: NSLocalizedString("notes_conversation_badge", comment: "Chat"),
                            icon: "message.fill",
                            color: .green,
                            style: .subtle
                        )
                    }

                    Spacer()

                    // Date
                    Text(note.createdAt.formatted(date: .abbreviated, time: .shortened))
                        .font(.brand(.footnote))
                        .foregroundStyle(Color.brandMutedForeground)
                }
            }
            .padding(12)
        }
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color.brandCard)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.brandBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.04), radius: 2, y: 1)
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Notes - Empty") {
    NotesView()
        .environment(AppState(hubContext: HubContext()))
        .environment(Router())
}
#endif
