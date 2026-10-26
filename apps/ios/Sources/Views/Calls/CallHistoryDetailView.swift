import SwiftUI

// MARK: - CallHistoryDetailView

/// One call from the history list: when it was, how it ended, how long it lasted, and — for
/// a holder of `notes:create` — an "Add Note" that opens the note editor on this call.
///
/// Reached only from the history list, which itself needs `calls:read-history`. Both gates
/// are permission checks, never a role. The caller's number is not repeated here.
struct CallHistoryDetailView: View {
    @Environment(AppState.self) private var appState
    let call: CallHistoryEntry

    @State private var noteCall: CallReference?

    private var reference: CallReference? {
        call.hubId.map {
            CallReference(id: call.id, hubId: $0, startedAt: call.startedAt, phase: .recorded(call.status))
        }
    }

    private var canAddNote: Bool {
        reference != nil && appState.hasPermission("notes:create")
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    ZStack {
                        Circle()
                            .fill(call.status.iconColor.opacity(0.15))
                            .frame(width: 40, height: 40)
                        Image(systemName: call.status.icon)
                            .font(.system(size: 16))
                            .foregroundStyle(call.status.iconColor)
                    }
                    Text(call.status.displayName)
                        .font(.brand(.headline))
                        .foregroundStyle(call.status.iconColor)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("call-detail-status")

                Text(call.startedAt.formatted(date: .complete, time: .shortened))
                    .font(.brand(.body))
                    .foregroundStyle(Color.brandForeground)
                    .accessibilityIdentifier("call-detail-started")

                if let duration = call.duration, duration > 0 {
                    LabeledContent(NSLocalizedString("calls_duration", comment: "Duration")) {
                        Text(Duration.seconds(duration).formatted(.time(pattern: duration >= 3600 ? .hourMinuteSecond : .minuteSecond)))
                            .font(.brandMono(.body))
                    }
                    .accessibilityIdentifier("call-detail-duration")
                }
            }

            if canAddNote {
                Section {
                    Button {
                        noteCall = reference
                    } label: {
                        Label(NSLocalizedString("calls_add_note", comment: "Add Note"), systemImage: "note.text.badge.plus")
                            .foregroundStyle(Color.brandPrimary)
                    }
                    .accessibilityIdentifier("call-detail-add-note")
                }
            }
        }
        .navigationTitle(NSLocalizedString("call_history_title", comment: "Call History"))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("call-detail-view")
        .sheet(item: $noteCall) { call in
            NoteCreateSheet(initialCall: call) { _ in }
        }
    }
}
