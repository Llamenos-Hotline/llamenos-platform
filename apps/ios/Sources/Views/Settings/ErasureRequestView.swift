import SwiftUI

/// Self-service erasure request view. Shows countdown if request is active,
/// or the request form if not. Accessible from Account Settings.
struct ErasureRequestView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModelBox = ViewModelBox<ErasureViewModel>()

    var body: some View {
        let vm = resolvedViewModel

        Group {
            if vm.isLoading && vm.activeRequest == nil {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let request = vm.activeRequest,
                      request.status == "scheduled" || request.status == "pending" {
                activeRequestView(request: request, vm: vm)
            } else {
                requestFormView(vm: vm)
            }
        }
        .navigationTitle(NSLocalizedString("erasure_request_title", comment: "Request Account Erasure"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await vm.loadStatus() }
        .alert(
            NSLocalizedString("erasure_request_confirm_title", comment: "Confirm Erasure Request"),
            isPresented: Binding(
                get: { vm.showRequestConfirmation },
                set: { vm.showRequestConfirmation = $0 }
            )
        ) {
            Button(NSLocalizedString("cancel", comment: "Cancel"), role: .cancel) {}
            Button(NSLocalizedString("erasure_request_confirm_button", comment: "Confirm Request"), role: .destructive) {
                Task { await vm.requestErasure() }
            }
        } message: {
            Text(NSLocalizedString(
                "erasure_request_confirm_message",
                comment: "Your account will be permanently erased after the waiting period."
            ))
        }
        .alert(
            NSLocalizedString("erasure_cancel_confirm_title", comment: "Cancel Erasure Request"),
            isPresented: Binding(
                get: { vm.showCancelConfirmation },
                set: { vm.showCancelConfirmation = $0 }
            )
        ) {
            Button(NSLocalizedString("cancel", comment: "Cancel"), role: .cancel) {}
            Button(NSLocalizedString("erasure_cancel_confirm_button", comment: "Yes, Cancel Erasure")) {
                Task { await vm.cancelErasure() }
            }
        } message: {
            Text(NSLocalizedString(
                "erasure_cancel_confirm_message",
                comment: "Are you sure you want to cancel your account erasure request?"
            ))
        }
        .accessibilityIdentifier("erasure-request-view")
    }

    // MARK: - Active Request (Countdown)

    private func activeRequestView(request: AppErasureRequest, vm: ErasureViewModel) -> some View {
        ScrollView {
            VStack(spacing: 24) {
                Image(systemName: "clock.badge.exclamationmark")
                    .font(.system(size: 56))
                    .foregroundStyle(.orange)
                    .padding(.top, 40)

                Text(NSLocalizedString("erasure_countdown_title", comment: "Account Erasure Scheduled"))
                    .font(.brand(.title2))

                Text(NSLocalizedString("erasure_countdown_message", comment: "Your account will be permanently erased in:"))
                    .font(.brand(.body))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)

                if let remaining = vm.timeRemaining {
                    CountdownDisplay(remaining: remaining)
                        .padding(.vertical, 16)
                }

                Button(role: .cancel) {
                    vm.showCancelConfirmation = true
                } label: {
                    Text(NSLocalizedString("erasure_cancel_button", comment: "Cancel Erasure"))
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .padding(.horizontal, 24)
                .disabled(vm.isMutating)
                .accessibilityIdentifier("cancel-erasure-button")
            }
        }
    }

    // MARK: - Request Form

    private func requestFormView(vm: ErasureViewModel) -> some View {
        ScrollView {
            VStack(spacing: 24) {
                Image(systemName: "person.crop.circle.badge.minus")
                    .font(.system(size: 56))
                    .foregroundStyle(Color.brandDestructive)
                    .padding(.top, 40)

                Text(NSLocalizedString("erasure_request_title", comment: "Request Account Erasure"))
                    .font(.brand(.title2))

                Text(NSLocalizedString(
                    "erasure_request_description",
                    comment: "This will permanently delete your account and all associated data after a waiting period."
                ))
                .font(.brand(.body))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)

                if let error = vm.errorMessage {
                    Text(error)
                        .font(.brand(.footnote))
                        .foregroundStyle(Color.brandDestructive)
                        .padding(.horizontal, 24)
                }

                Button(role: .destructive) {
                    vm.showRequestConfirmation = true
                } label: {
                    Text(NSLocalizedString("erasure_request_button", comment: "Request Erasure"))
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandDestructive)
                .padding(.horizontal, 24)
                .disabled(vm.isMutating)
                .accessibilityIdentifier("request-erasure-button")
            }
        }
    }

    // MARK: - ViewModel Resolution

    private var resolvedViewModel: ErasureViewModel {
        if let existing = viewModelBox.value { return existing }
        let vm = ErasureViewModel(apiService: appState.apiService)
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - CountdownDisplay

struct CountdownDisplay: View {
    let remaining: TimeInterval

    var body: some View {
        let days = Int(remaining) / 86400
        let hours = (Int(remaining) % 86400) / 3600
        let minutes = (Int(remaining) % 3600) / 60

        HStack(spacing: 16) {
            if days > 0 {
                countdownUnit(
                    value: days,
                    label: NSLocalizedString("erasure_countdown_days", comment: "days")
                )
            }
            countdownUnit(
                value: hours,
                label: NSLocalizedString("erasure_countdown_hours", comment: "hours")
            )
            countdownUnit(
                value: minutes,
                label: NSLocalizedString("erasure_countdown_minutes", comment: "minutes")
            )
        }
    }

    private func countdownUnit(value: Int, label: String) -> some View {
        VStack(spacing: 4) {
            Text("\(value)")
                .font(.brandMono(.largeTitle))
                .foregroundStyle(Color.brandForeground)
            Text(label)
                .font(.brand(.caption))
                .foregroundStyle(.secondary)
        }
        .frame(minWidth: 60)
        .padding(12)
        .background(Color.brandMuted.opacity(0.3))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}
