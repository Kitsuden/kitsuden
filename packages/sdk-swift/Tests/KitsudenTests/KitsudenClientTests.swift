import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import Kitsuden

/// Records the requests and answers with canned responses: no network.
final class FakeTransport: KitsudenTransport, @unchecked Sendable {
    struct Canned { let status: Int; let body: String; let headers: [String: String] }
    private let lock = NSLock()
    private var queue: [Canned]
    private(set) var requests: [URLRequest] = []

    init(_ responses: [Canned]) { queue = responses }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.lock(); defer { lock.unlock() }
        requests.append(request)
        let next = queue.isEmpty ? Canned(status: 500, body: "", headers: [:]) : queue.removeFirst()
        let response = HTTPURLResponse(url: request.url!, statusCode: next.status,
                                       httpVersion: "HTTP/1.1", headerFields: next.headers)!
        return (Data(next.body.utf8), response)
    }
}

func canned(_ status: Int, _ body: String, _ headers: [String: String] = [:]) -> FakeTransport.Canned {
    .init(status: status, body: body, headers: headers)
}

let entryJSON = """
{"id":"e1","dataSetId":"d1","title":"Hello","data":{"score":3,"tags":["a"]},
 "status":"published","sortOrder":1,"ownerId":null,"createdAt":"2026-11-04T00:00:00Z","updatedAt":"2026-11-04T00:00:00Z"}
"""

final class KitsudenClientTests: XCTestCase {
    let base = URL(string: "https://api.example.com/")!

    func testAgentKeyGoesInAuthorizationAndListsDecode() async throws {
        let fake = FakeTransport([canned(200, #"{"docs":[\#(entryJSON)]}"#)])
        let client = KitsudenClient(baseURL: base, credentials: .agentKey("kitsuden_agent_x"), transport: fake)

        let entries = try await client.listEntries(datasetId: "d1", limit: 10)

        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].data["score"], .number(3))
        let request = fake.requests[0]
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.absoluteString, "https://api.example.com/api/datasets/d1/entries?limit=10")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer kitsuden_agent_x")
        XCTAssertNil(request.value(forHTTPHeaderField: "Idempotency-Key"), "reads carry no key")
    }

    func testSessionTokenGoesInTheCookie() async throws {
        let fake = FakeTransport([canned(200, #"{"docs":[]}"#)])
        let client = KitsudenClient(
            baseURL: base,
            credentials: .session(token: "tok", cookieName: "__Secure-better-auth.session_token"),
            transport: fake)
        _ = try await client.listDatasets()
        XCTAssertEqual(fake.requests[0].value(forHTTPHeaderField: "Cookie"),
                       "__Secure-better-auth.session_token=tok")
        XCTAssertNil(fake.requests[0].value(forHTTPHeaderField: "Authorization"))
    }

    func testWritesCarryAnIdempotencyKeyAndAJSONBody() async throws {
        let fake = FakeTransport([canned(201, entryJSON), canned(200, entryJSON)])
        let client = KitsudenClient(baseURL: base, credentials: .agentKey("k"), transport: fake)

        let created = try await client.createEntry(
            datasetId: "d1", EntryInput(title: "Hello", data: ["score": 3]))
        XCTAssertEqual(created.value?.id, "e1")
        let key = fake.requests[0].value(forHTTPHeaderField: "Idempotency-Key")
        XCTAssertNotNil(key)
        XCTAssertEqual(fake.requests[0].httpMethod, "POST")
        let sent = try JSONDecoder().decode(JSONValue.self, from: fake.requests[0].httpBody!)
        XCTAssertEqual(sent["title"], .string("Hello"))

        _ = try await client.updateEntry(datasetId: "d1", entryId: "e1",
                                         EntryInput(title: "Bye"), idempotencyKey: "retry-key-0001")
        XCTAssertEqual(fake.requests[1].httpMethod, "PATCH")
        XCTAssertEqual(fake.requests[1].value(forHTTPHeaderField: "Idempotency-Key"), "retry-key-0001")
    }

    func testProblemJSONBecomesATypedError() async throws {
        let problem = """
        {"type":"x","title":"Rate limited","status":429,"code":"KITSUDEN_E_RATE_LIMITED",
         "detail":"Too many","retryable":true,"retry_after":7,"hint":"Wait","requestId":"r1"}
        """
        let fake = FakeTransport([canned(429, problem, ["Content-Type": "application/problem+json"])])
        let client = KitsudenClient(baseURL: base, transport: fake)
        do {
            _ = try await client.getDataset(id: "d1")
            XCTFail("expected an error")
        } catch let error as KitsudenAPIError {
            XCTAssertEqual(error.status, 429)
            XCTAssertEqual(error.code, "KITSUDEN_E_RATE_LIMITED")
            XCTAssertTrue(error.retryable)
            XCTAssertEqual(error.retryAfter, 7)
            XCTAssertEqual(error.requestId, "r1")
        }
    }

    func testANonProblemErrorStillGetsACatalogCode() async throws {
        let fake = FakeTransport([canned(503, "<html>bad gateway</html>", ["Retry-After": "5"])])
        let client = KitsudenClient(baseURL: base, transport: fake)
        do {
            _ = try await client.listDatasets()
            XCTFail("expected an error")
        } catch let error as KitsudenAPIError {
            XCTAssertEqual(error.code, "KITSUDEN_E_UNAVAILABLE")
            XCTAssertTrue(error.retryable)
            XCTAssertEqual(error.retryAfter, 5)
        }
    }

    func testA202ProposalIsReturnedNotThrown() async throws {
        let body = """
        {"code":"KITSUDEN_E_APPROVAL_REQUIRED","status":202,
         "proposal":{"id":"p1","status":"pending","statusUrl":"/api/agents/proposals/p1"}}
        """
        let fake = FakeTransport([canned(202, body)])
        let client = KitsudenClient(baseURL: base, credentials: .agentKey("k"), transport: fake)
        let result = try await client.deleteEntry(datasetId: "d1", entryId: "e1")
        guard case .pendingApproval(let proposal) = result else {
            return XCTFail("expected a pending proposal")
        }
        XCTAssertEqual(proposal.id, "p1")
        XCTAssertEqual(proposal.statusUrl, "/api/agents/proposals/p1")
        XCTAssertEqual(fake.requests[0].httpMethod, "DELETE")
        XCTAssertNotNil(fake.requests[0].value(forHTTPHeaderField: "Idempotency-Key"))
    }

    func testIdsAreEscapedInThePath() async throws {
        let fake = FakeTransport([canned(200, entryJSON)])
        let client = KitsudenClient(baseURL: base, transport: fake)
        _ = try await client.getEntry(datasetId: "a/b", entryId: "e 1")
        XCTAssertEqual(fake.requests[0].url?.absoluteString,
                       "https://api.example.com/api/datasets/a%2Fb/entries/e%201")
    }
}
