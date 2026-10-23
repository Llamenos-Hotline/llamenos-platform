import SwiftUI

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
