import Foundation
import XCTest
@testable import Llamenos

private struct CapturedHubCommunicationsRequest {
    let path: String
    let body: String
}

private final class HubCommunicationsStubURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var responses: [String: String] = [:]
    private static var capturedRequests: [CapturedHubCommunicationsRequest] = []

    static func reset(responses: [String: String]) {
        lock.lock()
        defer { lock.unlock() }
        self.responses = responses
        capturedRequests = []
    }

    static func requests() -> [CapturedHubCommunicationsRequest] {
        lock.lock()
        defer { lock.unlock() }
        return capturedRequests
    }

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "provider-templates.test"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let requestBodyData = request.httpBody ?? request.httpBodyStream.map(Self.readStream) ?? Data()
        let requestBody = String(data: requestBodyData, encoding: .utf8) ?? ""
        Self.lock.lock()
        let key = "\(request.httpMethod ?? "GET") \(path)"
        Self.capturedRequests.append(CapturedHubCommunicationsRequest(path: key, body: requestBody))
        let body = Self.responses[key]
        Self.lock.unlock()

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: body == nil ? 404 : 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((body ?? #"{"error":"Not Found"}"#).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readStream(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 1024)
        defer { buffer.deallocate() }

        while stream.hasBytesAvailable {
            let count = stream.read(buffer, maxLength: 1024)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

@MainActor
final class HubCommunicationsViewModelTests: XCTestCase {
    func testLoadTemplatesAppliesActiveTemplatesFromAPIResponse() async throws {
        let response = #"""
        {
          "templates": [
            {
              "id": "active-template",
              "name": "Active Twilio",
              "slug": "active-twilio",
              "providerType": "twilio",
              "defaultChannels": ["voice"],
              "credentialHints": {},
              "recommendedSettings": {},
              "allowSubAccounts": false,
              "isActive": true,
              "createdBy": "admin"
            },
            {
              "id": "inactive-template",
              "name": "Inactive Vonage",
              "slug": "inactive-vonage",
              "providerType": "vonage",
              "defaultChannels": ["sms"],
              "credentialHints": {},
              "recommendedSettings": {},
              "allowSubAccounts": false,
              "isActive": false,
              "createdBy": "admin"
            }
          ]
        }
        """#
        HubCommunicationsStubURLProtocol.reset(responses: [
            "GET /api/provider-templates": response,
        ])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HubCommunicationsStubURLProtocol.self]

        let api = APIService(
            cryptoService: CryptoService(),
            hubContext: HubContext(),
            sessionConfiguration: configuration
        )
        try api.configure(hubURLString: "https://provider-templates.test")
        let viewModel = HubCommunicationsViewModel(
            onboardAPI: HubOnboardAPI(api: api),
            providerService: ProviderSetupService(api: api),
            hubContext: HubContext()
        )

        await viewModel.loadTemplates()

        XCTAssertNil(viewModel.error, "A successful provider-template response should not set an error")
        XCTAssertEqual(
            viewModel.templates.map(\.id),
            ["active-template"],
            "The view model should apply the response and exclude inactive templates"
        )
        XCTAssertEqual(
            viewModel.templates.first?.name,
            "Active Twilio",
            "The applied template should retain the server's template data"
        )
        XCTAssertEqual(
            HubCommunicationsStubURLProtocol.requests().map { $0.path },
            ["GET /api/provider-templates"],
            "Loading templates should fetch the provider-template API response"
        )
    }

    func testStartFromScratchCompletesTemplateSelectionWithoutTemplate() async throws {
        let responses = [
            "POST /api/hubs/hub-001/onboard": #"""
            {
              "onboarding": {
                "hubId": "hub-001",
                "currentStep": "template_selection",
                "completedSteps": [],
                "channelConfig": {
                  "email": false,
                  "rcs": false,
                  "signal": false,
                  "sms": false,
                  "telegram": false,
                  "voice": false,
                  "whatsapp": false
                },
                "isComplete": false
              }
            }
            """#,
            "PUT /api/hubs/hub-001/onboard/step": #"""
            {
              "onboarding": {
                "hubId": "hub-001",
                "currentStep": "channel_selection",
                "completedSteps": ["template_selection"],
                "channelConfig": {
                  "email": false,
                  "rcs": false,
                  "signal": false,
                  "sms": false,
                  "telegram": false,
                  "voice": false,
                  "whatsapp": false
                },
                "isComplete": false
              }
            }
            """#,
        ]
        HubCommunicationsStubURLProtocol.reset(responses: responses)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HubCommunicationsStubURLProtocol.self]
        let context = HubContext()
        context.setActiveHub("hub-001")
        let api = APIService(
            cryptoService: CryptoService(),
            hubContext: context,
            sessionConfiguration: configuration
        )
        try api.configure(hubURLString: "https://provider-templates.test")
        let viewModel = HubCommunicationsViewModel(
            onboardAPI: HubOnboardAPI(api: api),
            providerService: ProviderSetupService(api: api),
            hubContext: context
        )

        await viewModel.startFromScratch()

        XCTAssertNil(viewModel.error, "Starting from scratch should complete the first onboarding step")
        XCTAssertNil(viewModel.selectedTemplate, "Starting from scratch should not select a template")
        XCTAssertEqual(viewModel.currentStep, .channels)
        XCTAssertEqual(viewModel.onboardingState?.currentStep, "channel_selection")
        XCTAssertEqual(viewModel.onboardingState?.completedSteps, ["template_selection"])

        let requests = HubCommunicationsStubURLProtocol.requests()
        XCTAssertEqual(
            requests.map { $0.path },
            [
                "POST /api/hubs/hub-001/onboard",
                "PUT /api/hubs/hub-001/onboard/step",
            ],
            "Starting from scratch should start onboarding and complete template selection"
        )
        guard let startBody = requests.first?.body,
              let body = try JSONSerialization.jsonObject(with: Data(startBody.utf8)) as? [String: Any] else {
            return XCTFail("Starting onboarding should send a JSON request body")
        }
        XCTAssertTrue(
            body["templateId"] == nil || body["templateId"] is NSNull,
            "Starting from scratch should send no selected template"
        )
        guard let stepBody = requests.last?.body,
              let step = try JSONSerialization.jsonObject(with: Data(stepBody.utf8)) as? [String: Any] else {
            return XCTFail("Completing template selection should send a JSON request body")
        }
        XCTAssertEqual(step["step"] as? String, "template_selection")
    }
}
