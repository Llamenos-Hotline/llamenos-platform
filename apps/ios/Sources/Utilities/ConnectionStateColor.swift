import SwiftUI

extension ConnectionState {
    var color: Color {
        switch self {
        case .connected: return .statusActive
        case .connecting, .subscribing, .reconnecting: return .statusWarning
        case .disconnected: return .brandDestructive
        }
    }
}
