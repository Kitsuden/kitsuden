import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// How the client authenticates.
public enum KitsudenCredentials: Sendable {
    /// An agent key (`kitsuden_agent_…`), sent as `Authorization: Bearer`.
    case agentKey(String)
    /// A signed-in user's better-auth session token, sent as a cookie. Behind
    /// HTTPS in production the cookie is called `__Secure-better-auth.session_token`.
    case session(token: String, cookieName: String = "better-auth.session_token")
    /// Public reads only.
    case none
}

/// What actually sends a request. `URLSession` by default; tests pass a fake.
public protocol KitsudenTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: KitsudenTransport {
    let session: URLSession
    public init(session: URLSession = .shared) { self.session = session }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw KitsudenTransportError.network("not an HTTP response")
        }
        return (data, http)
    }
}

/// A minimal Kitsuden client for apps: datasets and their entries.
///
/// ```swift
/// let kitsuden = KitsudenClient(baseURL: URL(string: "https://api.example.com")!,
///                               credentials: .agentKey(key))
/// let entries = try await kitsuden.listEntries(datasetId: id)
/// ```
///
/// Every write carries an `Idempotency-Key` (a new UUID unless you pass one): if the
/// network drops after the server acted, sending the SAME call again with the same
/// key returns the first result instead of acting twice.
public final class KitsudenClient: Sendable {
    public let baseURL: URL
    let credentials: KitsudenCredentials
    let transport: KitsudenTransport

    public init(baseURL: URL, credentials: KitsudenCredentials = .none,
                transport: KitsudenTransport = URLSessionTransport()) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.transport = transport
    }

    // ── Datasets ────────────────────────────────────────────────────────────

    /// The datasets this caller can read (1-200, default 50).
    public func listDatasets(limit: Int? = nil) async throws -> [Dataset] {
        let env: DocsEnvelope<Dataset> = try await read(
            "datasets", query: limit.map { [URLQueryItem(name: "limit", value: String($0))] } ?? [])
        return env.docs
    }

    public func getDataset(id: String) async throws -> Dataset {
        try await read("datasets/\(escape(id))")
    }

    // ── Entries ─────────────────────────────────────────────────────────────

    /// Entries in their order (1-1000, default 500), filtered by the dataset's rules.
    public func listEntries(datasetId: String, limit: Int? = nil) async throws -> [Entry] {
        let env: DocsEnvelope<Entry> = try await read(
            "datasets/\(escape(datasetId))/entries",
            query: limit.map { [URLQueryItem(name: "limit", value: String($0))] } ?? [])
        return env.docs
    }

    public func getEntry(datasetId: String, entryId: String) async throws -> Entry {
        try await read("datasets/\(escape(datasetId))/entries/\(escape(entryId))")
    }

    public func createEntry(datasetId: String, _ input: EntryInput,
                            idempotencyKey: String? = nil) async throws -> WriteResult<Entry> {
        try await write("POST", "datasets/\(escape(datasetId))/entries", body: input,
                        idempotencyKey: idempotencyKey)
    }

    public func updateEntry(datasetId: String, entryId: String, _ input: EntryInput,
                            idempotencyKey: String? = nil) async throws -> WriteResult<Entry> {
        try await write("PATCH", "datasets/\(escape(datasetId))/entries/\(escape(entryId))",
                        body: input, idempotencyKey: idempotencyKey)
    }

    public func deleteEntry(datasetId: String, entryId: String,
                            idempotencyKey: String? = nil) async throws -> WriteResult<Deleted> {
        try await write("DELETE", "datasets/\(escape(datasetId))/entries/\(escape(entryId))",
                        body: Optional<EntryInput>.none, idempotencyKey: idempotencyKey)
    }

    // ── Plumbing ────────────────────────────────────────────────────────────

    func escape(_ segment: String) -> String {
        segment.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["/"])) ?? segment
    }

    func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = []) -> URLRequest {
        // Built as text: appendingPathComponent would escape the `%` of an id we
        // already escaped. A base URL with a path (`https://host/kitsuden`) keeps it.
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        var components = URLComponents(string: "\(base)/api/\(path)")!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        switch credentials {
        case .agentKey(let key):
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        case .session(let token, let cookieName):
            request.setValue("\(cookieName)=\(token)", forHTTPHeaderField: "Cookie")
        case .none:
            break
        }
        return request
    }

    func read<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let (data, response) = try await send(makeRequest("GET", path, query: query))
        try check(response, data)
        return try decode(T.self, data)
    }

    func write<B: Encodable, T: Decodable & Sendable>(
        _ method: String, _ path: String, body: B?, idempotencyKey: String?
    ) async throws -> WriteResult<T> {
        var request = makeRequest(method, path)
        request.setValue(idempotencyKey ?? UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await send(request)
        if response.statusCode == 202, let proposal = pendingProposal(data) {
            return .pendingApproval(proposal)
        }
        try check(response, data)
        return .done(try decode(T.self, data))
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            return try await transport.send(request)
        } catch let error as KitsudenTransportError {
            throw error
        } catch {
            throw KitsudenTransportError.network(error.localizedDescription)
        }
    }

    func check(_ response: HTTPURLResponse, _ data: Data) throws {
        guard (200..<300).contains(response.statusCode) else {
            throw KitsudenAPIError.from(status: response.statusCode, body: data,
                                        retryAfterHeader: response.value(forHTTPHeaderField: "Retry-After"))
        }
    }

    /// A 202 is a pending proposal only when its `code` says so.
    func pendingProposal(_ data: Data) -> Proposal? {
        struct Body: Decodable { let code: String?; let proposal: Proposal? }
        guard let body = try? JSONDecoder().decode(Body.self, from: data),
              body.code == "KITSUDEN_E_APPROVAL_REQUIRED" else { return nil }
        return body.proposal
    }

    func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw KitsudenTransportError.decoding(String(describing: error))
        }
    }
}
