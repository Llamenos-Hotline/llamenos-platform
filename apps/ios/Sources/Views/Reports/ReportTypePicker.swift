import SwiftUI

// MARK: - ReportTypePicker

/// Shows available mobile-optimized report types as cards. Tapping a card
/// navigates to the template-driven report form for that type.
struct ReportTypePicker: View {
    let reportTypes: [CMSReportTypeListResponseReportType]
    let onSelect: (CMSReportTypeListResponseReportType) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(reportTypes) { reportType in
                        reportTypeCard(reportType)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 20)
            }
            .navigationTitle(NSLocalizedString("report_type_picker_title", comment: "Select Report Type"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        dismiss()
                    }
                    .accessibilityIdentifier("cancel-report-type-picker")
                }
            }
        }
    }

    // MARK: - Report Type Card

    @ViewBuilder
    private func reportTypeCard(_ reportType: CMSReportTypeListResponseReportType) -> some View {
        Button {
            onSelect(reportType)
        } label: {
            HStack(spacing: 14) {
                // Icon
                Image(systemName: reportType.icon ?? "doc.text.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(typeColor(reportType))
                    .frame(width: 44, height: 44)
                    .background(
                        RoundedRectangle(cornerRadius: 10)
                            .fill(typeColor(reportType).opacity(0.12))
                    )

                // Label and description
                VStack(alignment: .leading, spacing: 4) {
                    Text(reportType.label)
                        .font(.brand(.body))
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.brandForeground)
                        .lineLimit(1)

                    if !reportType.description.isEmpty {
                        Text(reportType.description)
                            .font(.brand(.caption))
                            .foregroundStyle(Color.brandMutedForeground)
                            .lineLimit(2)
                    }
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.brand(.caption))
                    .foregroundStyle(Color.brandMutedForeground)
            }
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.brandCard)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(Color.brandBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("report-type-\(reportType.name)")
    }

    // MARK: - Helpers

    /// Parse hex color from the report type definition, falling back to brand primary.
    private func typeColor(_ reportType: CMSReportTypeListResponseReportType) -> Color {
        if let hex = reportType.color {
            return Color(hex: hex) ?? .brandPrimary
        }
        return .brandPrimary
    }
}

// MARK: - Color Hex Extension

extension Color {
    /// Initialize a Color from a hex string like "#FF5733".
    init?(hex: String) {
        var cleaned = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("#") {
            cleaned.removeFirst()
        }
        guard cleaned.count == 6,
              let rgb = UInt64(cleaned, radix: 16) else {
            return nil
        }
        let r = Double((rgb >> 16) & 0xFF) / 255.0
        let g = Double((rgb >> 8) & 0xFF) / 255.0
        let b = Double(rgb & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Report Type Picker") {
    ReportTypePicker(
        reportTypes: [
            CMSReportTypeListResponseReportType(
                id: "1", name: "arrest_report", label: "Arrest Report",
                labelPlural: "Arrest Reports",
                description: "Document an arrest observed in the field",
                icon: "exclamationmark.shield.fill", color: "#E74C3C",
                category: "report",
                fields: [], statuses: [SharedStatus(value: "open", label: "Open", color: nil, icon: nil, order: 0, isDefault: true, isClosed: nil, isDeprecated: nil)],
                defaultStatus: "open",
                allowFileAttachments: true, allowCaseConversion: true,
                mobileOptimized: true, isArchived: false,
                hubId: nil, isSystem: nil, numberingEnabled: nil, numberPrefix: nil,
                templateId: nil, templateVersion: nil, closedStatuses: nil,
                createdAt: nil, updatedAt: nil
            ),
            CMSReportTypeListResponseReportType(
                id: "2", name: "misconduct_report", label: "Misconduct Report",
                labelPlural: "Misconduct Reports",
                description: "Report police misconduct or use of force",
                icon: "hand.raised.slash.fill", color: "#F39C12",
                category: "report",
                fields: [], statuses: [SharedStatus(value: "open", label: "Open", color: nil, icon: nil, order: 0, isDefault: true, isClosed: nil, isDeprecated: nil)],
                defaultStatus: "open",
                allowFileAttachments: true, allowCaseConversion: false,
                mobileOptimized: true, isArchived: false,
                hubId: nil, isSystem: nil, numberingEnabled: nil, numberPrefix: nil,
                templateId: nil, templateVersion: nil, closedStatuses: nil,
                createdAt: nil, updatedAt: nil
            ),
        ],
        onSelect: { _ in }
    )
}
#endif
