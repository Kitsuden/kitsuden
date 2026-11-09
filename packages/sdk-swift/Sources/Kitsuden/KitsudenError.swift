import Foundation

/// An error from the Kitsuden API. Every `/api/*` error is `application/problem+json`
/// (RFC 9457) with a stable `code` (`KITSUDEN_E_*`): branch on `code`, never on the
/// message. `retryable` says whether repeating the SAME request may succeed;
/// `retryAfter` how many seconds to wait first.
public struct KitsudenAPIError: Error, Equatable, Sendable, CustomStringConvertible {
    public let status: Int
    public let code: String
    public let title: String?
    public let detail: String?
    public let hint: String?
    public let retryable: Bool
    public let retryAfter: Double?
    public let requestId: String?

    public var description: String {
        var text = "\(code) (HTTP \(status))"
        if let detail { text += ": \(detail)" }
        if let hint { text += " — \(hint)" }
        return text
    }

    /// Statuses that are retryable even when the body is not a problem
    /// (a proxy's 502 page, a gateway timeout).
    static let retryableStatuses: Set<Int> = [408, 429, 502, 503, 504]

    static func from(status: Int, body: Data, retryAfterHeader: String?) -> KitsudenAPIError {
        let headerWait = retryAfterHeader.flatMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard let problem = try? JSONDecoder().decode(JSONValue.self, from: body),
              case .object = problem
        else {
            return KitsudenAPIError(
                status: status, code: fallbackCode(status), title: nil, detail: nil, hint: nil,
                retryable: retryableStatuses.contains(status), retryAfter: headerWait, requestId: nil)
        }
        return KitsudenAPIError(
            status: status,
            code: problem["code"]?.stringValue ?? fallbackCode(status),
            title: problem["title"]?.stringValue,
            detail: problem["detail"]?.stringValue ?? problem["error"]?.stringValue,
            hint: problem["hint"]?.stringValue,
            retryable: problem["retryable"]?.boolValue ?? retryableStatuses.contains(status),
            retryAfter: problem["retry_after"]?.doubleValue ?? headerWait,
            requestId: problem["requestId"]?.stringValue)
    }

    /// The catalog code for a status, when the body carried none.
    static func fallbackCode(_ status: Int) -> String {
        switch status {
        case 400: return "KITSUDEN_E_BAD_REQUEST"
        case 401: return "KITSUDEN_E_UNAUTHENTICATED"
        case 403: return "KITSUDEN_E_FORBIDDEN"
        case 404: return "KITSUDEN_E_NOT_FOUND"
        case 409: return "KITSUDEN_E_CONFLICT"
        case 413: return "KITSUDEN_E_PAYLOAD_TOO_LARGE"
        case 422: return "KITSUDEN_E_VALIDATION"
        case 429: return "KITSUDEN_E_RATE_LIMITED"
        case 502: return "KITSUDEN_E_BAD_GATEWAY"
        case 503: return "KITSUDEN_E_UNAVAILABLE"
        case 504: return "KITSUDEN_E_TIMEOUT"
        default: return "KITSUDEN_E_INTERNAL"
        }
    }
}

/// No HTTP response at all (offline, DNS, timeout), or a success body that is not
/// the JSON the operation promises.
public enum KitsudenTransportError: Error, Sendable {
    case network(String)
    case decoding(String)
}
