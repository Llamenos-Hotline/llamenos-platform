import SwiftUI

// MARK: - Custody chain
// Custody entries decode to generated `CustodyChainResponse` whose elements
// are generated `CustodyChain` (packages/protocol/schemas/evidence.ts).

extension CustodyChain: Identifiable {}

// MARK: - EvidenceCustodyChainView

/// Displays the chain of custody for a single evidence item.
struct EvidenceCustodyChainView: View {
    let evidenceId: String
    @Environment(AppState.self) private var appState

    @State private var entries: [CustodyChain] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage {
                ContentUnavailableView(
                    NSLocalizedString("cms_custody_load_error", comment: "Failed to load custody chain"),
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage)
                )
            } else if entries.isEmpty {
                ContentUnavailableView(
                    NSLocalizedString("cms_custody_empty", comment: "No custody entries"),
                    systemImage: "shield"
                )
            } else {
                List {
                    ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                        CustodyEntryRow(index: index + 1, entry: entry)
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
        .navigationTitle(NSLocalizedString("cms_custody_chain", comment: "Chain of Custody"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadChain() }
    }

    private func loadChain() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: CustodyChainResponse = try await appState.apiService.request(
                method: "GET",
                path: "/evidence/\(evidenceId)/custody"
            )
            entries = response.custodyChain
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - CustodyEntryRow

private struct CustodyEntryRow: View {
    let index: Int
    let entry: CustodyChain

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle()
                    .fill(actionColor.opacity(0.15))
                    .frame(width: 32, height: 32)
                Image(systemName: actionIcon)
                    .font(.caption)
                    .foregroundStyle(actionColor)
            }

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(entry.action.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(.subheadline)
                        .fontWeight(.medium)
                    Spacer()
                    Text("#\(index)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Text(entry.actorPubkey.prefix(16) + "…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fontDesign(.monospaced)

                Text(entry.timestamp)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("custody-entry-\(entry.id)")
    }

    private var actionIcon: String {
        switch entry.action {
        case .uploaded: return "shield"
        case .integrityVerified: return "checkmark.shield"
        case .viewed: return "eye"
        case .downloaded, .exported, .shared: return "square.and.arrow.up"
        }
    }

    private var actionColor: Color {
        switch entry.action {
        case .uploaded: return .blue
        case .integrityVerified: return .green
        case .viewed: return .secondary
        case .downloaded, .exported, .shared: return .brandPrimary
        }
    }
}

// MARK: - EntityCalendarView (iOS)

/// Groups entity records by month and displays them in a calendar-like list.
struct EntityCalendarView: View {
    let records: [SharedRecordListResponseRecord]
    let onSelectRecord: (SharedRecordListResponseRecord) -> Void

    private var grouped: [(String, [SharedRecordListResponseRecord])] {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM"

        let dict = Dictionary(grouping: records) { record -> String in
            formatter.string(from: ISO8601DateFormatter().date(from: record.createdAt) ?? Date())
        }
        return dict.sorted { $0.key > $1.key }
    }

    var body: some View {
        List {
            ForEach(grouped, id: \.0) { month, recs in
                Section(header: monthHeader(month)) {
                    ForEach(recs) { record in
                        Button { onSelectRecord(record) } label: {
                            CalendarRecordRow(record: record)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("calendar-record-\(record.id)")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if records.isEmpty {
                ContentUnavailableView(
                    NSLocalizedString("cases_no_cases", comment: "No records"),
                    systemImage: "calendar"
                )
            }
        }
    }

    private func monthHeader(_ monthKey: String) -> some View {
        let parts = monthKey.split(separator: "-")
        let year = parts.first.map(String.init) ?? ""
        let month = parts.count > 1 ? Int(parts[1]) ?? 1 : 1
        let date = Calendar.current.date(from: DateComponents(year: Int(year), month: month)) ?? Date()
        let label = date.formatted(.dateTime.month(.wide).year())
        return Text(label)
    }
}

private struct CalendarRecordRow: View {
    let record: SharedRecordListResponseRecord
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(ISO8601DateFormatter().date(from: record.createdAt)?.formatted(date: .abbreviated, time: .omitted) ?? record.createdAt)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(record.id.prefix(8) + "…")
                    .font(.subheadline)
                    .fontDesign(.monospaced)
            }
            Spacer()
            Text(record.statusHash.prefix(6))
                .font(.caption2)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(.secondary.opacity(0.15), in: Capsule())
        }
    }
}

// MARK: - EntityTimelineView (iOS)

/// Displays entity records in newest-first vertical timeline order.
struct EntityTimelineView: View {
    let records: [SharedRecordListResponseRecord]
    let onSelectRecord: (SharedRecordListResponseRecord) -> Void

    private var sorted: [SharedRecordListResponseRecord] {
        records.sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        ScrollView {
            if sorted.isEmpty {
                ContentUnavailableView(
                    NSLocalizedString("cases_no_cases", comment: "No records"),
                    systemImage: "clock"
                )
                .padding(.top, 60)
            } else {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(sorted) { record in
                        TimelineRecordRow(record: record) {
                            onSelectRecord(record)
                        }
                    }
                }
                .padding(.horizontal)
            }
        }
    }
}

private struct TimelineRecordRow: View {
    let record: SharedRecordListResponseRecord
    let onTap: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                Circle()
                    .fill(.primary.opacity(0.3))
                    .frame(width: 8, height: 8)
                    .padding(.top, 6)
                Rectangle()
                    .fill(.secondary.opacity(0.2))
                    .frame(width: 1)
                    .frame(maxHeight: .infinity)
            }

            Button(action: onTap) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(ISO8601DateFormatter().date(from: record.createdAt)?.formatted(.dateTime.month().day().hour().minute()) ?? record.createdAt)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        if !record.statusHash.isEmpty {
                            Text(record.statusHash.prefix(6))
                                .font(.caption2)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.secondary.opacity(0.15), in: Capsule())
                        }
                    }
                    Text(record.id.prefix(16) + "…")
                        .font(.subheadline)
                        .fontDesign(.monospaced)
                }
                .padding(.vertical, 8)
                .padding(.horizontal, 12)
                .background(.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("timeline-record-\(record.id)")
        }
        .padding(.vertical, 4)
    }
}
