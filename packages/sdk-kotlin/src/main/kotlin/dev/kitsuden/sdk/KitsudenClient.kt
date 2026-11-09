package dev.kitsuden.sdk

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** How the client authenticates. */
sealed class Credentials {
    /** An agent key (`kitsuden_agent_…`), sent as `Authorization: Bearer`. */
    data class AgentKey(val key: String) : Credentials()

    /**
     * A signed-in user's better-auth session token, sent as a cookie. Behind HTTPS in
     * production the cookie is called `__Secure-better-auth.session_token`.
     */
    data class Session(val token: String, val cookieName: String = "better-auth.session_token") : Credentials()

    /** Public reads only. */
    data object None : Credentials()
}

data class HttpRequest(val method: String, val url: String, val headers: Map<String, String>, val body: String?)

data class HttpResponse(val status: Int, val headers: Map<String, String>, val body: String) {
    fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
}

/** What actually sends a request. [UrlConnectionTransport] by default; tests pass a fake. */
fun interface HttpTransport {
    suspend fun send(request: HttpRequest): HttpResponse
}

/** `HttpURLConnection` on [Dispatchers.IO]: exists on the JVM and on Android. */
class UrlConnectionTransport(private val timeoutMillis: Int = 30_000) : HttpTransport {
    override suspend fun send(request: HttpRequest): HttpResponse = withContext(Dispatchers.IO) {
        val connection = URI(request.url).toURL().openConnection() as HttpURLConnection
        try {
            connection.requestMethod = request.method
            connection.connectTimeout = timeoutMillis
            connection.readTimeout = timeoutMillis
            connection.instanceFollowRedirects = false
            request.headers.forEach { (k, v) -> connection.setRequestProperty(k, v) }
            if (request.body != null) {
                connection.doOutput = true
                connection.outputStream.use { it.write(request.body.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val body = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            val headers = connection.headerFields
                .filterKeys { it != null }
                .mapValues { (_, values) -> values.joinToString(", ") }
            HttpResponse(status, headers, body)
        } finally {
            connection.disconnect()
        }
    }
}

/**
 * A minimal Kitsuden client for apps: datasets and their entries.
 *
 * ```kotlin
 * val kitsuden = KitsudenClient("https://api.example.com", Credentials.AgentKey(key))
 * val entries = kitsuden.listEntries(datasetId)
 * ```
 *
 * Every write carries an `Idempotency-Key` (a new UUID unless you pass one): if the
 * network drops after the server acted, sending the SAME call again with the same key
 * returns the first result instead of acting twice.
 */
class KitsudenClient(
    baseUrl: String,
    private val credentials: Credentials = Credentials.None,
    private val transport: HttpTransport = UrlConnectionTransport(),
) {
    private val base = baseUrl.trimEnd('/')

    // ── Datasets ────────────────────────────────────────────────────────────

    /** The datasets this caller can read (1-200, default 50). */
    suspend fun listDatasets(limit: Int? = null): List<Dataset> =
        docs(read("datasets", limit?.let { mapOf("limit" to "$it") } ?: emptyMap())).map(Dataset::from)

    suspend fun getDataset(id: String): Dataset = Dataset.from(read("datasets/${seg(id)}"))

    // ── Entries ─────────────────────────────────────────────────────────────

    /** Entries in their order (1-1000, default 500), filtered by the dataset's rules. */
    suspend fun listEntries(datasetId: String, limit: Int? = null): List<Entry> =
        docs(read("datasets/${seg(datasetId)}/entries", limit?.let { mapOf("limit" to "$it") } ?: emptyMap()))
            .map(Entry::from)

    suspend fun getEntry(datasetId: String, entryId: String): Entry =
        Entry.from(read("datasets/${seg(datasetId)}/entries/${seg(entryId)}"))

    suspend fun createEntry(datasetId: String, input: EntryInput, idempotencyKey: String? = null): WriteResult<Entry> =
        write("POST", "datasets/${seg(datasetId)}/entries", input.toJson(), idempotencyKey, Entry::from)

    suspend fun updateEntry(
        datasetId: String,
        entryId: String,
        input: EntryInput,
        idempotencyKey: String? = null,
    ): WriteResult<Entry> =
        write("PATCH", "datasets/${seg(datasetId)}/entries/${seg(entryId)}", input.toJson(), idempotencyKey, Entry::from)

    /** `Done(true)` when deleted. */
    suspend fun deleteEntry(datasetId: String, entryId: String, idempotencyKey: String? = null): WriteResult<Boolean> =
        write("DELETE", "datasets/${seg(datasetId)}/entries/${seg(entryId)}", null, idempotencyKey) { true }

    // ── Plumbing ────────────────────────────────────────────────────────────

    /** One path segment, escaped (a `/` in an id must not become a path). */
    internal fun seg(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private fun url(path: String, query: Map<String, String>): String {
        val q = if (query.isEmpty()) "" else "?" + query.entries.joinToString("&") { (k, v) -> "${seg(k)}=${seg(v)}" }
        return "$base/api/$path$q"
    }

    private fun headers(): MutableMap<String, String> {
        val h = mutableMapOf("Accept" to "application/json")
        when (val c = credentials) {
            is Credentials.AgentKey -> h["Authorization"] = "Bearer ${c.key}"
            is Credentials.Session -> h["Cookie"] = "${c.cookieName}=${c.token}"
            Credentials.None -> Unit
        }
        return h
    }

    private suspend fun send(request: HttpRequest): HttpResponse =
        try {
            transport.send(request)
        } catch (e: IOException) {
            throw KitsudenNetworkException(e.message ?: "network error", e)
        }

    private fun check(response: HttpResponse) {
        if (response.status !in 200..299) {
            throw KitsudenApiException.fromResponse(response.status, response.body, response.header("Retry-After"))
        }
    }

    private fun parse(body: String): JsonElement =
        try {
            Json.parseToJsonElement(body)
        } catch (e: Exception) {
            throw KitsudenDecodeException("response is not JSON", e)
        }

    private fun docs(json: JsonElement): List<JsonElement> =
        (json.jsonObject["docs"] as? JsonArray) ?: throw KitsudenDecodeException("response without docs")

    private suspend fun read(path: String, query: Map<String, String> = emptyMap()): JsonElement {
        val response = send(HttpRequest("GET", url(path, query), headers(), null))
        check(response)
        return parse(response.body)
    }

    private suspend fun <T> write(
        method: String,
        path: String,
        body: JsonObject?,
        idempotencyKey: String?,
        decode: (JsonElement) -> T,
    ): WriteResult<T> {
        val h = headers()
        h["Idempotency-Key"] = idempotencyKey ?: UUID.randomUUID().toString()
        if (body != null) h["Content-Type"] = "application/json"
        val response = send(HttpRequest(method, url(path, emptyMap()), h, body?.toString()))
        if (response.status == 202) pendingProposal(response.body)?.let { return WriteResult.PendingApproval(it) }
        check(response)
        return WriteResult.Done(decode(parse(response.body)))
    }

    /** A 202 is a pending proposal only when its `code` says so. */
    private fun pendingProposal(body: String): Proposal? {
        val o = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
        if (o.string("code") != "KITSUDEN_E_APPROVAL_REQUIRED") return null
        val p = o["proposal"] as? JsonObject ?: return null
        return Proposal(
            id = p.string("id") ?: return null,
            status = p.string("status") ?: "pending",
            statusUrl = p.string("statusUrl") ?: return null,
            reason = p.string("reason"),
        )
    }
}
