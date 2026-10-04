import Foundation

/// A value that is safe to substitute into a localized format string.
///
/// The i18n codegen renders every `{{placeholder}}` in `packages/i18n/locales`
/// as a positional **object** specifier (`%1$@`). `String(format:)` reads a `%@`
/// argument out of the `va_list` and dereferences it as an object pointer, so
/// handing it an `Int` — which is passed as a plain integer — segfaults inside
/// `_NSDescriptionWithStringProxyFunc`.
///
/// Conforming types render themselves to a `String` first, so the value that
/// reaches `String(format:)` is always a real object. See issue #1413.
///
/// `Double` and `Float` deliberately do **not** conform: an implicit rendering
/// would silently produce `"12.0"` where the caller meant `"12"`. Format them at
/// the call site (`String(format: "%.0f", ms)`) and pass the resulting `String`.
protocol LocalizedFormatArgument {
    var localizedFormatValue: String { get }
}

extension String: LocalizedFormatArgument {
    var localizedFormatValue: String { self }
}

extension Substring: LocalizedFormatArgument {
    var localizedFormatValue: String { String(self) }
}

extension Int: LocalizedFormatArgument {
    var localizedFormatValue: String { String(self) }
}

extension Int32: LocalizedFormatArgument {
    var localizedFormatValue: String { String(self) }
}

extension Int64: LocalizedFormatArgument {
    var localizedFormatValue: String { String(self) }
}

extension UInt: LocalizedFormatArgument {
    var localizedFormatValue: String { String(self) }
}

extension UInt32: LocalizedFormatArgument {
    var localizedFormatValue: String { String(self) }
}

extension UInt64: LocalizedFormatArgument {
    var localizedFormatValue: String { String(self) }
}

/// Localized string lookup with substitution.
///
/// This is the only supported way to interpolate into a localized string on iOS.
/// Calling `String(format:)` on a localized template is rejected by
/// `packages/i18n/tools/validate-strings.ts`: the generated specifier is always
/// `%N$@`, and a non-object argument crashes at render time.
///
///     Text(L10n.format("events_page_indicator", vm.currentPage, vm.totalPages))
///
/// When the key is absent from the generated `.strings` the lookup returns the
/// bare key, which carries no specifiers and consumes no arguments — so a
/// missing translation renders the key rather than crashing, and *adding* the
/// translation later cannot arm a crash.
enum L10n {
    static func format(
        _ key: String,
        comment: String = "",
        _ arguments: any LocalizedFormatArgument...
    ) -> String {
        let template = NSLocalizedString(key, comment: comment)
        return String(format: template, arguments: arguments.map { $0.localizedFormatValue as CVarArg })
    }
}
