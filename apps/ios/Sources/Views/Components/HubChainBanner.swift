import SwiftUI

/// The active hub's authority-chain alerts (#2963): a fork or a refused
/// (unauthorised or invalid) chain — sealing in the hub has stopped — and the
/// advisory stale-signer finding (D13). The verdict itself lives in
/// ``HubChainService`` and gates sealing for every hub, active or not.
struct HubChainBanner: View {
    let hubChain: HubChainService
    let hubId: String?

    @State private var status: HubChainService.Status?

    var body: some View {
        Group {
            switch status {
            case .fork?:
                alert(title: NSLocalizedString("hub_chain_alert_fork_title", comment: "Hub chain fork"), kind: "fork")
            case .refused(let code, _)?:
                alert(
                    title: NSLocalizedString("hub_chain_alert_refused_title", comment: "Hub chain refused"),
                    kind: code == "chain_unauthorised_signer" ? "unauthorised" : "invalid"
                )
            case .verified(_, let stale, _)? where stale > 0:
                HStack(spacing: 12) {
                    Image(systemName: "exclamationmark.shield").foregroundStyle(.orange).accessibilityHidden(true)
                    Text(L10n.format("hub_chain_alert_stale_signer", comment: "Stale signer", stale))
                        .font(.subheadline)
                    Spacer()
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
                .background(.orange.opacity(0.1))
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("hub-chain-alert-stale_signer")
            default:
                EmptyView()
            }
        }
        .task(id: hubId) {
            guard let hubId else { status = nil; return }
            status = hubChain.status(hubId: hubId)
            if status == nil { status = try? await hubChain.load(hubId: hubId) }
        }
        .onReceive(NotificationCenter.default.publisher(for: HubChainService.statusDidChange)) { note in
            guard let changed = note.object as? String, changed == hubId else { return }
            status = hubChain.status(hubId: changed)
        }
    }

    private func alert(title: String, kind: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.shield.fill").foregroundStyle(.red).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(NSLocalizedString("hub_chain_alert_sealing_stopped", comment: "Sealing stopped")).font(.footnote)
            }
            Spacer()
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(.red.opacity(0.1))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("hub-chain-alert-\(kind)")
    }
}
