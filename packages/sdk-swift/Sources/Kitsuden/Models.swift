import Foundation

/// A dataset (a typed collection). `schema` is its field definition.
public struct Dataset: Decodable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let slug: String
    public let description: String?
    public let icon: String?
    public let schema: JSONValue?
    public let createdAt: String?
    public let updatedAt: String?
}

/// One entry of a dataset. `data` holds the fields the dataset schema defines.
public struct Entry: Decodable, Equatable, Sendable {
    public let id: String
    public let dataSetId: String
    public let title: String?
    public let data: JSONValue
    public let status: String?
    public let sortOrder: Double?
    public let ownerId: String?
    public let createdAt: String?
    public let updatedAt: String?
}

/// The body of an entry write. Only `title` and `data` are for everyone;
/// `status` and `sortOrder` are staff-only and are rejected for other callers.
public struct EntryInput: Encodable, Sendable {
    public var title: String?
    public var data: [String: JSONValue]?
    public var status: String?
    public var sortOrder: Double?

    public init(title: String? = nil, data: [String: JSONValue]? = nil,
                status: String? = nil, sortOrder: Double? = nil) {
        self.title = title
        self.data = data
        self.status = status
        self.sortOrder = sortOrder
    }
}

/// A request an agent made that a human must approve first (HTTP 202,
/// `KITSUDEN_E_APPROVAL_REQUIRED`). Nothing ran. Do not resend: poll `statusUrl`
/// with the same credentials.
public struct Proposal: Decodable, Equatable, Sendable {
    public let id: String
    public let status: String
    public let statusUrl: String
    public let reason: String?
}

/// What a write returns: done, or held for human approval.
public enum WriteResult<T: Sendable>: Sendable {
    case done(T)
    case pendingApproval(Proposal)

    /// The value, or `nil` when the write waits for approval.
    public var value: T? {
        if case .done(let v) = self { return v }
        return nil
    }
}

/// `{ "success": true }` from a delete.
public struct Deleted: Decodable, Equatable, Sendable {
    public let success: Bool
}

struct DocsEnvelope<T: Decodable>: Decodable {
    let docs: [T]
}
