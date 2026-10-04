import SwiftUI

struct ContactForNotification: Identifiable {
    let id: String
    let displayName: String
    let recipientHash: String
    let availableChannels: [String]
}

struct ContactNotificationSheet: View {
    let recordId: String
    let contacts: [ContactForNotification]
    let statusLabel: String
    let caseNumber: String?
    let hubName: String
    let apiService: APIService
    @Environment(\.dismiss) private var dismiss

    @State private var selected: Set<String> = []
    @State private var channels: [String: String] = [:]
    @State private var isSending = false
    @State private var error: String?

    private var renderedMessage: String {
        let cn = caseNumber ?? "N/A"
        return L10n.format("notifications_status_change_template", comment: "", cn, hubName, statusLabel)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(renderedMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .italic()
                }

                Section(NSLocalizedString("notifications_contacts_section", comment: "Contacts")) {
                    ForEach(contacts) { contact in
                        HStack {
                            Toggle(contact.displayName, isOn: Binding(
                                get: { selected.contains(contact.id) },
                                set: { on in
                                    if on { selected.insert(contact.id) }
                                    else { selected.remove(contact.id) }
                                }
                            ))
                            .toggleStyle(.automatic)

                            if selected.contains(contact.id) && contact.availableChannels.count > 1 {
                                Picker("", selection: Binding(
                                    get: { channels[contact.id] ?? contact.availableChannels[0] },
                                    set: { channels[contact.id] = $0 }
                                )) {
                                    ForEach(contact.availableChannels, id: \.self) { ch in
                                        Text(ch).tag(ch)
                                    }
                                }
                                .pickerStyle(.menu)
                                .labelsHidden()
                            }
                        }
                    }
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.caption) }
                }
            }
            .navigationTitle(NSLocalizedString("notifications_title", comment: "Notify Contacts?"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("notifications_skip", comment: "Skip")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("notifications_send", comment: "Send")) {
                        Task { await send() }
                    }
                    .disabled(selected.isEmpty || isSending)
                }
            }
            .overlay {
                if isSending { ProgressView() }
            }
        }
    }

    private func send() async {
        isSending = true
        error = nil
        let notifications = selected.compactMap { contactId -> [String: String]? in
            guard let contact = contacts.first(where: { $0.id == contactId }) else { return nil }
            return [
                "recipientHash": contact.recipientHash,
                "channel": channels[contactId] ?? contact.availableChannels.first ?? "sms",
                "message": renderedMessage,
            ]
        }
        do {
            let _: [String: String] = try await apiService.request(
                method: "POST",
                path: apiService.hp("/api/records/\(recordId)/notify-contacts"),
                body: ["notifications": notifications]
            )
            isSending = false
            dismiss()
        } catch let err {
            error = err.localizedDescription
            isSending = false
        }
    }
}
