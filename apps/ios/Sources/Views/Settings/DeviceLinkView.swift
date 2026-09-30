import SwiftUI
import AVFoundation
import UIKit

// MARK: - DeviceLinkView

/// Device linking flow that uses QR code scanning and ephemeral ECDH to
/// securely transfer a device key from the desktop app to this device.
///
/// Steps:
/// 1. Camera QR scanner captures the provisioning room URL
/// 2. Connects to the relay and exchanges ephemeral public keys
/// 3. Both devices derive and display a 6-digit SAS verification code
/// 4. User confirms codes match (prevents MITM)
/// 5. Desktop sends encrypted device key, mobile decrypts and imports
struct DeviceLinkView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var viewModelBox = ViewModelBox<DeviceLinkViewModel>()

    /// No NavigationStack of its own: the login flow pushes this view onto the
    /// NavigationStack it already has, and a stack pushed inside a stack is not
    /// supported. Presenters that show it modally (Account settings) wrap it in one.
    var body: some View {
        let vm = resolvedViewModel

        VStack {
            switch vm.currentStep {
            case .scanning:
                scanningStep(vm: vm)
            case .connecting:
                connectingStep
            case .verifying(let sasCode):
                verifyingStep(sasCode: sasCode, vm: vm)
            case .importing:
                importingStep
            case .completed:
                completedStep
            case .error(let message):
                errorStep(message: message, vm: vm)
            }
        }
        .navigationTitle(NSLocalizedString("device_link_title", comment: "Link Device"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                if case .completed = vm.currentStep {
                    // Show "Done" instead of "Cancel" on completion
                } else {
                    Button(NSLocalizedString("cancel", comment: "Cancel")) {
                        vm.cancel()
                        dismiss()
                    }
                    .accessibilityIdentifier("cancel-device-link")
                }
            }
        }
        .task {
            await vm.requestCameraPermission()
        }
        // A container only carries an identifier once it is an accessibility element.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("device-link-view")
    }

    // MARK: - Step 1: Scanning

    @ViewBuilder
    private func scanningStep(vm: DeviceLinkViewModel) -> some View {
        VStack(spacing: 24) {
            // Instructions
            VStack(spacing: 12) {
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 56))
                    .foregroundStyle(Color.brandPrimary)
                    .accessibilityHidden(true)

                Text(NSLocalizedString(
                    "device_link_scan_title",
                    comment: "Scan QR Code"
                ))
                .font(.brand(.title2))
                .fontWeight(.bold)

                Text(NSLocalizedString(
                    "device_link_scan_instructions",
                    comment: "Open Settings > Link Device on your desktop app and scan the QR code shown there."
                ))
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            }
            .padding(.top, 32)

            // Camera preview area
            if vm.hasCameraPermission {
                QRScannerView(onCodeScanned: { code in
                    vm.processQRCode(code)
                })
                .frame(maxWidth: .infinity)
                .frame(height: 300)
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .overlay(
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(Color.brandPrimary.opacity(0.3), lineWidth: 2)
                )
                .padding(.horizontal, 24)
                .accessibilityIdentifier("qr-scanner")
            } else {
                noCameraPermissionView
            }

            Spacer()
        }
    }

    // MARK: - No Camera Permission

    private var noCameraPermissionView: some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.fill")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)

            Text(NSLocalizedString(
                "device_link_no_camera",
                comment: "Camera access is required to scan the QR code."
            ))
            .font(.brand(.subheadline))
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)

            Button(NSLocalizedString("device_link_open_settings", comment: "Open Settings")) {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("open-camera-settings")
        }
        .padding(32)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(Color.brandCard)
        )
        .padding(.horizontal, 24)
    }

    // MARK: - Step 2: Connecting

    private var connectingStep: some View {
        VStack(spacing: 24) {
            Spacer()

            ProgressView()
                .scaleEffect(1.5)

            Text(NSLocalizedString(
                "device_link_connecting",
                comment: "Connecting to relay..."
            ))
            .font(.brand(.title3))
            .fontWeight(.medium)

            Text(NSLocalizedString(
                "device_link_connecting_detail",
                comment: "Establishing secure connection with your desktop."
            ))
            .font(.brand(.subheadline))
            .foregroundStyle(Color.brandMutedForeground)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)

            Spacer()
        }
        .accessibilityIdentifier("device-link-connecting")
    }

    // MARK: - Step 3: Verifying

    @ViewBuilder
    private func verifyingStep(sasCode: String, vm: DeviceLinkViewModel) -> some View {
        VStack(spacing: 32) {
            Spacer()

            // SAS code display
            VStack(spacing: 16) {
                Image(systemName: "checkmark.shield.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(Color.statusActive)
                    .accessibilityHidden(true)

                Text(NSLocalizedString(
                    "device_link_verify_title",
                    comment: "Verify Connection"
                ))
                .font(.brand(.title2))
                .fontWeight(.bold)

                Text(NSLocalizedString(
                    "device_link_verify_instructions",
                    comment: "Confirm this code matches the one shown on your desktop:"
                ))
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            }

            // Large SAS code display
            HStack(spacing: 12) {
                ForEach(Array(sasCode.enumerated()), id: \.offset) { _, digit in
                    Text(String(digit))
                        .font(.system(size: 36, weight: .bold, design: .monospaced))
                        .foregroundStyle(Color.brandPrimary)
                        .frame(width: 44, height: 56)
                        .background(
                            RoundedRectangle(cornerRadius: 10)
                                .fill(Color.brandCard)
                        )
                }
            }
            .padding(.vertical, 8)
            .accessibilityIdentifier("sas-code-display")
            .accessibilityLabel(String(format: NSLocalizedString(
                "device_link_sas_code",
                comment: "Verification code: %@"
            ), sasCode))

            // Confirm / Reject buttons
            VStack(spacing: 12) {
                Button {
                    vm.confirmSASCode()
                } label: {
                    Label(
                        NSLocalizedString("device_link_codes_match", comment: "Codes Match"),
                        systemImage: "checkmark.circle.fill"
                    )
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.statusActive)
                .accessibilityIdentifier("confirm-sas-code")

                Button(role: .destructive) {
                    vm.rejectSASCode()
                } label: {
                    Label(
                        NSLocalizedString("device_link_codes_mismatch", comment: "Codes Don't Match"),
                        systemImage: "xmark.circle.fill"
                    )
                    .fontWeight(.medium)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("reject-sas-code")
            }
            .padding(.horizontal, 24)

            Spacer()
        }
        .accessibilityIdentifier("device-link-verifying")
    }

    // MARK: - Step 4: Importing

    private var importingStep: some View {
        VStack(spacing: 24) {
            Spacer()

            ProgressView()
                .scaleEffect(1.5)

            Text(NSLocalizedString(
                "device_link_importing",
                comment: "Importing identity..."
            ))
            .font(.brand(.title3))
            .fontWeight(.medium)

            Text(NSLocalizedString(
                "device_link_importing_detail",
                comment: "Decrypting and importing your key to this device."
            ))
            .font(.brand(.subheadline))
            .foregroundStyle(Color.brandMutedForeground)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)

            Spacer()
        }
        .accessibilityIdentifier("device-link-importing")
    }

    // MARK: - Step 5: Completed

    private var completedStep: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(Color.statusActive)
                .accessibilityHidden(true)

            Text(NSLocalizedString(
                "device_link_success",
                comment: "Device Linked!"
            ))
            .font(.brand(.title))
            .fontWeight(.bold)

            Text(NSLocalizedString(
                "device_link_success_detail",
                comment: "Your identity has been securely transferred to this device. Set a PIN to protect it."
            ))
            .font(.brand(.subheadline))
            .foregroundStyle(Color.brandMutedForeground)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)

            Button {
                dismiss()
            } label: {
                Text(NSLocalizedString("device_link_continue", comment: "Continue"))
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .padding(.horizontal, 24)
            .accessibilityIdentifier("device-link-continue")

            Spacer()
        }
        .accessibilityIdentifier("device-link-completed")
    }

    // MARK: - Error State

    @ViewBuilder
    private func errorStep(message: String, vm: DeviceLinkViewModel) -> some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 56))
                .foregroundStyle(Color.brandDestructive)
                .accessibilityHidden(true)

            Text(NSLocalizedString(
                "device_link_error_title",
                comment: "Linking Failed"
            ))
            .font(.brand(.title2))
            .fontWeight(.bold)

            Text(message)
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            Button {
                vm.retry()
            } label: {
                Text(NSLocalizedString("device_link_retry", comment: "Try Again"))
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.bordered)
            .padding(.horizontal, 24)
            .accessibilityIdentifier("device-link-retry")

            Spacer()
        }
        .accessibilityIdentifier("device-link-error")
    }

    // MARK: - ViewModel Resolution

    private var resolvedViewModel: DeviceLinkViewModel {
        if let vm = viewModelBox.value {
            return vm
        }
        let vm = DeviceLinkViewModel(
            cryptoService: appState.cryptoService,
            authService: appState.authService,
            keychainService: appState.keychainService
        )
        viewModelBox.value = vm
        return vm
    }
}

// MARK: - QRScannerView

/// UIViewRepresentable wrapper for `AVCaptureSession` that scans QR codes
/// using the device camera. Calls `onCodeScanned` exactly once per scan session.
struct QRScannerView: UIViewRepresentable {
    typealias UIViewType = UIView
    typealias Coordinator = QRScannerCoordinator
    let onCodeScanned: (String) -> Void

    func makeUIView(context: UIViewRepresentableContext<QRScannerView>) -> UIView {
        let view = UIView(frame: .zero)
        view.backgroundColor = .black

        let captureSession = AVCaptureSession()
        context.coordinator.captureSession = captureSession

        guard let videoCaptureDevice = AVCaptureDevice.default(for: .video) else {
            return view
        }

        guard let videoInput = try? AVCaptureDeviceInput(device: videoCaptureDevice) else {
            return view
        }

        if captureSession.canAddInput(videoInput) {
            captureSession.addInput(videoInput)
        }

        let metadataOutput = AVCaptureMetadataOutput()
        if captureSession.canAddOutput(metadataOutput) {
            captureSession.addOutput(metadataOutput)
            metadataOutput.setMetadataObjectsDelegate(context.coordinator, queue: DispatchQueue.main)
            metadataOutput.metadataObjectTypes = [.qr]
        }

        let previewLayer = AVCaptureVideoPreviewLayer(session: captureSession)
        previewLayer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(previewLayer)
        context.coordinator.previewLayer = previewLayer

        DispatchQueue.global(qos: .userInitiated).async {
            captureSession.startRunning()
        }

        return view
    }

    func updateUIView(_ uiView: UIView, context: UIViewRepresentableContext<QRScannerView>) {
        context.coordinator.previewLayer?.frame = uiView.bounds
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: QRScannerCoordinator) {
        coordinator.captureSession?.stopRunning()
    }


    func makeCoordinator() -> QRScannerCoordinator {
        QRScannerCoordinator(onCodeScanned: onCodeScanned)
    }

    class QRScannerCoordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let onCodeScanned: (String) -> Void
        var captureSession: AVCaptureSession?
        var previewLayer: AVCaptureVideoPreviewLayer?
        private var hasScanned = false

        init(onCodeScanned: @escaping (String) -> Void) {
            self.onCodeScanned = onCodeScanned
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard !hasScanned else { return }

            if let metadataObject = metadataObjects.first,
               let readableObject = metadataObject as? AVMetadataMachineReadableCodeObject,
               let stringValue = readableObject.stringValue {
                hasScanned = true

                // Haptic feedback
                let generator = UIImpactFeedbackGenerator(style: .medium)
                generator.impactOccurred()

                // Stop scanning
                captureSession?.stopRunning()

                onCodeScanned(stringValue)
            }
        }

        deinit {
            captureSession?.stopRunning()
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Device Link - Scanning") {
    NavigationStack {
        DeviceLinkView()
    }
    .environment(AppState(hubContext: HubContext()))
}
#endif
