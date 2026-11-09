package dev.kitsuden.sdk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Records requests and answers with canned responses: no network. */
class FakeTransport(vararg responses: HttpResponse) : HttpTransport {
    private val queue = ArrayDeque(responses.toList())
    val requests = mutableListOf<HttpRequest>()
    override suspend fun send(request: HttpRequest): HttpResponse {
        requests += request
        return queue.removeFirstOrNull() ?: HttpResponse(500, emptyMap(), "")
    }
}

private fun ok(status: Int, body: String, headers: Map<String, String> = emptyMap()) = HttpResponse(status, headers, body)

private const val ENTRY = """{"id":"e1","dataSetId":"d1","title":"Hello","data":{"score":3},"status":"published",
"sortOrder":1,"ownerId":null,"createdAt":"2026-11-04T00:00:00Z","updatedAt":"2026-11-04T00:00:00Z"}"""

class KitsudenClientTest {
    @Test
    fun agentKeyGoesInAuthorizationAndListsDecode() = runTest {
        val fake = FakeTransport(ok(200, """{"docs":[$ENTRY]}"""))
        val client = KitsudenClient("https://api.example.com/", Credentials.AgentKey("kitsuden_agent_x"), fake)

        val entries = client.listEntries("d1", limit = 10)

        assertEquals(1, entries.size)
        assertEquals("3", entries[0].data["score"]!!.jsonPrimitive.content)
        val r = fake.requests[0]
        assertEquals("GET", r.method)
        assertEquals("https://api.example.com/api/datasets/d1/entries?limit=10", r.url)
        assertEquals("Bearer kitsuden_agent_x", r.headers["Authorization"])
        assertNull(r.headers["Idempotency-Key"], "reads carry no key")
    }

    @Test
    fun sessionTokenGoesInTheCookie() = runTest {
        val fake = FakeTransport(ok(200, """{"docs":[]}"""))
        val client = KitsudenClient(
            "https://api.example.com",
            Credentials.Session("tok", "__Secure-better-auth.session_token"),
            fake,
        )
        client.listDatasets()
        assertEquals("__Secure-better-auth.session_token=tok", fake.requests[0].headers["Cookie"])
        assertNull(fake.requests[0].headers["Authorization"])
    }

    @Test
    fun writesCarryAnIdempotencyKeyAndAJsonBody() = runTest {
        val fake = FakeTransport(ok(201, ENTRY), ok(200, ENTRY))
        val client = KitsudenClient("https://api.example.com", Credentials.AgentKey("k"), fake)

        val created = client.createEntry(
            "d1",
            EntryInput(title = "Hello", data = buildJsonObject { put("score", JsonPrimitive(3)) }),
        )
        assertEquals("e1", created.valueOrNull()?.id)
        assertNotNull(fake.requests[0].headers["Idempotency-Key"])
        assertEquals("POST", fake.requests[0].method)
        val sent = Json.parseToJsonElement(fake.requests[0].body!!).jsonObject
        assertEquals("Hello", sent["title"]!!.jsonPrimitive.content)
        assertNull(sent["status"], "nulls are not sent")

        client.updateEntry("d1", "e1", EntryInput(title = "Bye"), idempotencyKey = "retry-key-0001")
        assertEquals("PATCH", fake.requests[1].method)
        assertEquals("retry-key-0001", fake.requests[1].headers["Idempotency-Key"])
    }

    @Test
    fun problemJsonBecomesATypedError() = runTest {
        val problem = """{"title":"Rate limited","status":429,"code":"KITSUDEN_E_RATE_LIMITED","detail":"Too many",
            "retryable":true,"retry_after":7,"hint":"Wait","requestId":"r1"}"""
        val client = KitsudenClient("https://api.example.com", transport = FakeTransport(ok(429, problem)))
        val e = assertFailsWith<KitsudenApiException> { client.getDataset("d1") }
        assertEquals(429, e.status)
        assertEquals("KITSUDEN_E_RATE_LIMITED", e.code)
        assertTrue(e.retryable)
        assertEquals(7.0, e.retryAfter)
        assertEquals("r1", e.requestId)
    }

    @Test
    fun aNonProblemErrorStillGetsACatalogCode() = runTest {
        val fake = FakeTransport(ok(503, "<html>bad gateway</html>", mapOf("retry-after" to "5")))
        val client = KitsudenClient("https://api.example.com", transport = fake)
        val e = assertFailsWith<KitsudenApiException> { client.listDatasets() }
        assertEquals("KITSUDEN_E_UNAVAILABLE", e.code)
        assertTrue(e.retryable)
        assertEquals(5.0, e.retryAfter)
    }

    @Test
    fun a202ProposalIsReturnedNotThrown() = runTest {
        val body = """{"code":"KITSUDEN_E_APPROVAL_REQUIRED","status":202,
            "proposal":{"id":"p1","status":"pending","statusUrl":"/api/agents/proposals/p1"}}"""
        val fake = FakeTransport(ok(202, body))
        val client = KitsudenClient("https://api.example.com", Credentials.AgentKey("k"), fake)
        val result = client.deleteEntry("d1", "e1")
        val pending = assertIs<WriteResult.PendingApproval>(result)
        assertEquals("p1", pending.proposal.id)
        assertEquals("DELETE", fake.requests[0].method)
        assertNotNull(fake.requests[0].headers["Idempotency-Key"])
    }

    @Test
    fun idsAreEscapedInThePath() = runTest {
        val fake = FakeTransport(ok(200, ENTRY))
        KitsudenClient("https://api.example.com", transport = fake).getEntry("a/b", "e 1")
        assertEquals("https://api.example.com/api/datasets/a%2Fb/entries/e%201", fake.requests[0].url)
    }
}
