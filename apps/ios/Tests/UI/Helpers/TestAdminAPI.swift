import CryptoKit
import Foundation
import XCTest

/// Real, authenticated API calls from the UI test runner, signed as the test admin —
/// the iOS counterpart of desktop's tests/api-helpers.ts. Use it to put the server in
/// the state a scenario's Given-steps describe, instead of writing tests that branch
/// on whatever state the server happens to be in.
///
/// The test admin is the identity the test backend runs with as ADMIN_PUBKEY
/// (79215a4c…af9183, ci.yml TEST_ADMIN_PUBKEY); `seedHex` is its Ed25519 seed, the
/// same fixture as ADMIN_SEED in tests/helpers.ts. Requests carry the per-request
/// Ed25519 token the server verifies in apps/worker/lib/auth.ts: a signature over
/// `LABEL_DEVICE_AUTH:pubkey:timestamp:METHOD:path`.
enum TestAdminAPI {
    static let seedHex = "f54a5851e9372b87810a8e60cdd2e7cfd80b6e31c7af18188f7db106ceda8be7" // gitleaks:allow

    /// Enable (or disable) case management for a hub.
    static func setCaseManagement(enabled: Bool, hubId: String, baseURL: String,
                                  file: StaticString = #filePath, line: UInt = #line) {
        send("PUT", "/api/hubs/\(hubId)/settings/cms/case-management", ["enabled": enabled],
             baseURL: baseURL, file: file, line: line)
    }

    /// Apply a bundled CMS template (packages/protocol/templates/<id>.json) to a hub.
    static func applyTemplate(_ templateId: String, hubId: String, baseURL: String,
                              file: StaticString = #filePath, line: UInt = #line) {
        send("POST", "/api/hubs/\(hubId)/settings/cms/templates/apply", ["templateId": templateId, "hubId": hubId],
             baseURL: baseURL, file: file, line: line)
    }

    /// Send a signed JSON request and fail the calling test on anything but 2xx.
    @discardableResult
    static func send(_ method: String, _ path: String, _ body: [String: Any]? = nil, baseURL: String,
                     file: StaticString = #filePath, line: UInt = #line) -> Data? {
        guard let url = URL(string: baseURL + path) else {
            XCTFail("Invalid URL \(baseURL)\(path)", file: file, line: line)
            return nil
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            request.setValue("Bearer \(try authorization(method: method, path: url.path))",
                             forHTTPHeaderField: "Authorization")
            if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        } catch {
            XCTFail("Could not sign \(method) \(path): \(error)", file: file, line: line)
            return nil
        }

        var status = -1
        var responseData: Data?
        var transportError: String?
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, error in
            defer { done.signal() }
            transportError = error?.localizedDescription
            status = (response as? HTTPURLResponse)?.statusCode ?? -1
            responseData = data
        }.resume()
        guard done.wait(timeout: .now() + 20) == .success else {
            XCTFail("\(method) \(path) timed out", file: file, line: line)
            return nil
        }
        guard (200...299).contains(status) else {
            let text = responseData.map { String(decoding: $0, as: UTF8.self) } ?? ""
            XCTFail("\(method) \(path) → \(transportError ?? "HTTP \(status)") \(text)", file: file, line: line)
            return nil
        }
        return responseData
    }

    /// `{"pubkey","timestamp","token"}` for the Authorization header.
    /// Internal rather than private: `BaseUITest.createClassHub` signs its own
    /// request so it can keep a 60s timeout (a first request on a freshly
    /// booted CI runner has taken 30-49s, where `send` allows 15s). Sharing
    /// the signing keeps one implementation of the token format.
    static func authorization(method: String, path: String) throws -> String {
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(hexString: seedHex))
        let pubkey = key.publicKey.rawRepresentation.hexString
        let timestamp = Int(Date().timeIntervalSince1970 * 1000)
        let message = "\(CryptoLabels.LABEL_DEVICE_AUTH):\(pubkey):\(timestamp):\(method):\(path)"
        let token = try key.signature(for: Data(message.utf8)).hexString
        let json = try JSONSerialization.data(withJSONObject: ["pubkey": pubkey, "timestamp": timestamp, "token": token])
        return String(decoding: json, as: UTF8.self)
    }
}

private extension Data {
    init(hexString: String) {
        var bytes = [UInt8]()
        bytes.reserveCapacity(hexString.count / 2)
        var index = hexString.startIndex
        while index < hexString.endIndex {
            let next = hexString.index(index, offsetBy: 2)
            bytes.append(UInt8(hexString[index..<next], radix: 16) ?? 0)
            index = next
        }
        self.init(bytes)
    }

    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
