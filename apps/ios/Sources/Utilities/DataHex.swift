import Foundation

extension Data {
    /// Parse a hex string (even length, no separators) into bytes.
    /// Returns nil for odd-length or non-hex input.
    init?(hexString: String) {
        let count = hexString.count
        guard count % 2 == 0 else { return nil }
        var bytes = [UInt8]()
        bytes.reserveCapacity(count / 2)
        var index = hexString.startIndex
        while index < hexString.endIndex {
            let next = hexString.index(index, offsetBy: 2)
            guard let byte = UInt8(hexString[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self.init(bytes)
    }
}
