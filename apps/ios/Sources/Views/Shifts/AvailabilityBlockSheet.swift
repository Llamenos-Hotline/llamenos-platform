import SwiftUI

// MARK: - AvailabilityBlockSheet

/// "Mark unavailable" form: an inclusive date range plus an optional reason.
/// Parity with the desktop Availability tab's create form.
struct AvailabilityBlockSheet: View {
    @Bindable var viewModel: ShiftsViewModel

    @State private var startDate = Date()
    @State private var endDate = Date()
    @State private var reason = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker(
                        NSLocalizedString("shifts_availability_start_date", comment: "Start Date"),
                        selection: $startDate,
                        displayedComponents: .date
                    )
                    .accessibilityIdentifier("availability-start-date")

                    DatePicker(
                        NSLocalizedString("shifts_availability_end_date", comment: "End Date"),
                        selection: $endDate,
                        in: startDate...,
                        displayedComponents: .date
                    )
                    .accessibilityIdentifier("availability-end-date")
                }

                Section {
                    TextField(
                        NSLocalizedString("shifts_availability_reason", comment: "Reason (optional)"),
                        text: $reason,
                        axis: .vertical
                    )
                    .accessibilityIdentifier("availability-reason-input")
                }
            }
            .navigationTitle(NSLocalizedString("shifts_availability_create", comment: "Add Availability Block"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        dismiss()
                    }
                    .accessibilityIdentifier("availability-cancel-button")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("save", comment: "Save")) {
                        Task {
                            if await viewModel.createAvailabilityBlock(
                                startDate: startDate,
                                endDate: endDate,
                                reason: reason
                            ) {
                                dismiss()
                            }
                        }
                    }
                    .accessibilityIdentifier("availability-save-button")
                }
            }
        }
    }
}
