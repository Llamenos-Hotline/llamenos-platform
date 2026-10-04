import SwiftUI

struct CopyableField: View {
    let label: String
    let value: String
    var truncated: Bool = true

    @State private var showCopied = false

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
                Text(truncated ? value.truncatedHash() : value)
                    .font(.brandMono(.caption))
                    .foregroundStyle(Color.brandForeground)
                    .lineLimit(1)
            }

            Spacer()

            Button {
                UIPasteboard.general.string = value
                Haptics.impact(.light)
                withAnimation { showCopied = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    withAnimation { showCopied = false }
                }
            } label: {
                Image(systemName: showCopied ? "checkmark" : "doc.on.doc")
                    .font(.caption)
                    .foregroundStyle(showCopied ? Color.statusActive : Color.brandPrimary)
                    .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("copy-field-button")
            .accessibilityLabel(L10n.format("a11y_copy_field", comment: "Copy %@", label))
        }
        .accessibilityElement(children: .contain)
    }
}
